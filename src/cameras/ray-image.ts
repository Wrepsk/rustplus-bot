import type { CameraRays } from '../rust/protocol';

// Ray codec, palette and seeded shuffle follow rustplus.js/camera.js (MIT).
// Unlike its stateless ten-packet renderer, keep a bounded per-pixel sample cache.
// Self-contained so the same tested implementation can run inside the render worker.
export class RayImage {
  private positions: Uint32Array;
  private colours: Uint8ClampedArray;
  private sampled: Float64Array;
  private depths: Uint16Array;
  private materials: Uint16Array;
  private latest = 0;
  private epoch = -Infinity;
  private moving = false;
  private motionUntil = 0;
  constructor(
    private width: number,
    private height: number,
  ) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 512 ||
      height > 512
    )
      throw new Error('Unsupported camera dimensions.');
    const count = width * height;
    this.positions = Uint32Array.from({ length: count }, (_, i) => i);
    // Preserve upstream's signed xorshift and negative-state conversion exactly.
    let state = 1337;
    const next = () => {
      const previous = state;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return previous >= 0 ? previous : 4294967295 + previous - 1;
    };
    next();
    for (let i = count - 1; i >= 1; i--) {
      let swap = ((next() * (i + 1)) / 4294967295) | 0;
      if (swap < 0) swap = i + swap;
      [this.positions[i], this.positions[swap]] = [this.positions[swap], this.positions[i]];
    }
    this.colours = new Uint8ClampedArray(count * 4);
    this.sampled = new Float64Array(count).fill(-Infinity);
    this.depths = new Uint16Array(count);
    this.materials = new Uint16Array(count);
  }
  motion(active: boolean, now: number): void {
    if (active !== this.moving) {
      this.sampled.fill(-Infinity);
      this.epoch = now;
    }
    this.moving = active;
    this.motionUntil = active ? now + 1200 : 0;
  }
  add(frame: CameraRays, now: number): void {
    if (now < this.epoch) return;
    if (
      !(frame.rayData instanceof Uint8Array) ||
      frame.rayData.length > 65536 ||
      !Number.isInteger(frame.sampleOffset) ||
      frame.sampleOffset < 0 ||
      frame.sampleOffset > 2147483647
    )
      throw new Error('Invalid camera rays.');
    this.latest = now;
    const palette = [
      [0.5, 0.5, 0.5],
      [0.8, 0.7, 0.7],
      [0.3, 0.7, 1],
      [0.6, 0.6, 0.6],
      [0.7, 0.7, 0.7],
      [0.8, 0.6, 0.4],
      [1, 0.4, 0.4],
      [1, 0.1, 0.1],
    ];
    const lookback = new Int32Array(64 * 3),
      data = frame.rayData;
    let cursor = 0,
      offset = frame.sampleOffset % this.positions.length;
    const byte = () => {
      if (cursor >= data.length) throw new Error('Truncated camera ray.');
      return data[cursor++];
    };
    while (cursor < data.length) {
      const n = byte(),
        kind = n & 192,
        slot = (n & 63) * 3;
      let distance: number, alignment: number, material: number;
      if (n === 255 || kind === 192) {
        const a = byte(),
          b = byte();
        distance = (a << 2) | (b >> 6);
        alignment = b & 63;
        material = n === 255 ? byte() : n & 63;
        const hash = (3 * ((distance / 128) | 0) + 5 * ((alignment / 16) | 0) + 7 * material) & 63;
        lookback.set([distance, alignment, material], hash * 3);
      } else {
        distance = lookback[slot];
        alignment = lookback[slot + 1];
        material = lookback[slot + 2];
        if (kind === 64) {
          const delta = byte();
          distance += (delta >> 3) - 15;
          alignment += (delta & 7) - 3;
        } else if (kind === 128) distance += byte() - 127;
      }
      const position = this.positions[offset];
      offset = (offset + 1) % this.positions.length;
      // Server sample coordinates use a bottom-left origin.
      const index =
        (this.height - 1 - Math.floor(position / this.width)) * this.width +
        (position % this.width);
      const pixel = index * 4;
      if (distance === 1023 && alignment === 0 && material === 0)
        this.colours.set([208, 230, 252, 255], pixel);
      else {
        const colour = palette[((material % 8) + 8) % 8];
        for (let channel = 0; channel < 3; channel++)
          this.colours[pixel + channel] = Math.max(
            0,
            Math.min(255, Math.floor((alignment / 63) * colour[channel] * 255)),
          );
        this.colours[pixel + 3] = 255;
      }
      this.sampled[index] = now;
      this.depths[index] = Math.max(0, Math.min(1023, distance));
      this.materials[index] = material;
    }
  }
  render(
    now: number,
    reconstruct = true,
  ): { width: number; height: number; data: Uint8ClampedArray; mode: 'pose' | 'spatial' } {
    if (this.moving && now >= this.motionUntil) this.motion(false, now);
    // Keep fresh observed pixels at native detail. Reconstruct only missing pixels;
    // averaging 2x2 blocks and then enlarging blurred even fully sampled views.
    const width = this.width,
      height = this.height,
      count = width * height;
    const data = new Uint8ClampedArray(count * 4);
    const nearest = new Int32Array(count).fill(-1),
      distance = new Uint8Array(count).fill(255);
    const cutoff = this.moving ? Math.max(now - 300, this.latest - 150) : -Infinity;
    for (let i = 0; i < count; i++) {
      if (this.sampled[i] === -Infinity || this.sampled[i] < cutoff) continue;
      data.set(this.colours.subarray(i * 4, i * 4 + 4), i * 4);
      nearest[i] = i;
      distance[i] = 0;
    }
    if (reconstruct) {
      // Bounded spatial hole filling in two linear passes. Real sampled pixels, including
      // genuine black surfaces, are never replaced. No full-image guessed background.
      const propagate = (to: number, from: number) => {
        if (distance[from] < (this.moving ? 16 : 3) && distance[from] + 1 < distance[to]) {
          distance[to] = distance[from] + 1;
          nearest[to] = nearest[from];
        }
      };
      for (let i = 0; i < count; i++) {
        if (i % width) propagate(i, i - 1);
        if (i >= width) propagate(i, i - width);
      }
      for (let i = count - 1; i >= 0; i--) {
        if (i % width < width - 1) propagate(i, i + 1);
        if (i < count - width) propagate(i, i + width);
      }
      for (let i = 0; i < count; i++)
        if (nearest[i] >= 0 && nearest[i] !== i) {
          if (this.moving && distance[i] <= 2) this.fillGap(data, nearest, i);
          else data.set(this.colours.subarray(nearest[i] * 4, nearest[i] * 4 + 4), i * 4);
        }
    }
    return { width, height, data, mode: 'spatial' };
  }
  private fillGap(data: Uint8ClampedArray, nearest: Int32Array, index: number): void {
    // Local interpolation uses only real rays on the nearest observed surface.
    // Material and relative encoded depth gate blending across walls/foreground.
    // This is screen-space gap filling, not world-space camera reprojection.
    const guide = nearest[index],
      x = index % this.width,
      y = Math.floor(index / this.width);
    const tolerance = Math.max(8, this.depths[guide] * 0.05);
    let total = 0,
      r = 0,
      g = 0,
      b = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const sx = x + dx,
          sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) continue;
        const source = sy * this.width + sx;
        // Filled pixels never become new interpolation sources.
        if (
          nearest[source] !== source ||
          this.materials[source] !== this.materials[guide] ||
          Math.abs(this.depths[source] - this.depths[guide]) > tolerance
        )
          continue;
        const weight = 1 / (dx * dx + dy * dy),
          pixel = source * 4;
        total += weight;
        r += this.colours[pixel] * weight;
        g += this.colours[pixel + 1] * weight;
        b += this.colours[pixel + 2] * weight;
      }
    const target = index * 4;
    if (!total) data.set(this.colours.subarray(guide * 4, guide * 4 + 4), target);
    else
      data.set([Math.round(r / total), Math.round(g / total), Math.round(b / total), 255], target);
  }
}
