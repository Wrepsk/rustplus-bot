import type { CameraRays } from '../rust/protocol';

// Ray codec, palette and seeded shuffle follow rustplus.js/camera.js (MIT).
// Unlike its stateless ten-packet renderer, keep a bounded per-pixel sample cache.
// Self-contained so the same tested implementation can run inside the render worker.
export class RayImage {
  private positions: Uint32Array;
  private colours: Uint8ClampedArray;
  private sampled: Float64Array;
  private world: Float64Array;
  private sky: Uint8Array;
  private latest = 0;
  private pose?: {
    position: number[];
    rotation: number[];
    fov: number;
    range: number;
    matrix: number[];
    sampling: number[];
  };
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
    this.world = new Float64Array(count * 3);
    this.sky = new Uint8Array(count);
  }
  motion(active: boolean, now: number): void {
    if (active !== this.moving && !this.pose) {
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
    const pose = this.readPose(frame);
    if (!!pose !== !!this.pose) this.sampled.fill(-Infinity);
    if (
      pose &&
      this.pose &&
      (pose.position.some((v, i) => Math.abs(v - this.pose!.position[i]) > 0.00001) ||
        pose.rotation.some((v, i) => Math.abs(v - this.pose!.rotation[i]) > 0.00001) ||
        Math.abs(pose.fov - this.pose.fov) > 0.00001)
    ) {
      this.reproject(pose, now);
      this.moving = true;
      this.motionUntil = now + 1200;
    }
    this.pose = pose;
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
      let index =
        (this.height - 1 - Math.floor(position / this.width)) * this.width +
        (position % this.width);
      if (pose) {
        const tan = Math.tan((pose.fov * Math.PI) / 360);
        const x =
          (((((position % this.width) + 0.5) / this.width) * 2 - 1) * tan * this.width) /
          this.height;
        const y = (((Math.floor(position / this.width) + 0.5) / this.height) * 2 - 1) * tan;
        const length = Math.hypot(x, y, 1),
          matrix = pose.sampling;
        const direction = [
          (matrix[0] * x + matrix[1] * y + matrix[2]) / length,
          (matrix[3] * x + matrix[4] * y + matrix[5]) / length,
          (matrix[6] * x + matrix[7] * y + matrix[8]) / length,
        ];
        // New rays may use a jittered sampling orientation. Place them in the
        // unjittered display view, as well as moving old samples with the camera.
        index = this.project(direction[0], direction[1], direction[2], pose);
        if (index < 0) continue;
        const isSky = distance === 1023 && alignment === 0 && material === 0;
        this.sky[index] = isSky ? 1 : 0;
        for (let c = 0; c < 3; c++)
          this.world[index * 3 + c] = isSky
            ? direction[c]
            : pose.position[c] + ((direction[c] * Math.max(0, distance)) / 1023) * pose.range;
      }
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
    }
  }
  private readPose(frame: CameraRays): typeof this.pose {
    const p = frame.cameraPosition,
      r = frame.cameraRotation,
      sampling = frame.sampleRotation || r;
    if (
      !p ||
      !r ||
      !sampling ||
      ![
        p.x,
        p.y,
        p.z,
        r.x,
        r.y,
        r.z,
        sampling.x,
        sampling.y,
        sampling.z,
        frame.verticalFov,
        frame.distance,
      ].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7) ||
      frame.verticalFov! < 5 ||
      frame.verticalFov! > 170 ||
      frame.distance! <= 0
    )
      return undefined;
    return {
      position: [p.x, p.y, p.z],
      rotation: [r.x, r.y, r.z],
      fov: frame.verticalFov!,
      range: frame.distance!,
      matrix: this.rotation(r),
      sampling: this.rotation(sampling),
    };
  }
  private rotation(r: { x: number; y: number; z: number }): number[] {
    const [x, y, z] = [r.x, r.y, r.z].map((v) => (v * Math.PI) / 180);
    const [sx, cx, sy, cy, sz, cz] = [
      Math.sin(x),
      Math.cos(x),
      Math.sin(y),
      Math.cos(y),
      Math.sin(z),
      Math.cos(z),
    ];
    // Unity's Euler convention: Z, then X, then Y; camera forward is +Z.
    return [
      cy * cz + sy * sx * sz,
      -cy * sz + sy * sx * cz,
      sy * cx,
      cx * sz,
      cx * cz,
      -sx,
      -sy * cz + cy * sx * sz,
      sy * sz + cy * sx * cz,
      cy * cx,
    ];
  }
  private project(vx: number, vy: number, vz: number, pose: NonNullable<typeof this.pose>): number {
    const m = pose.matrix,
      tan = Math.tan((pose.fov * Math.PI) / 360);
    const x = m[0] * vx + m[3] * vy + m[6] * vz,
      y = m[1] * vx + m[4] * vy + m[7] * vz,
      z = m[2] * vx + m[5] * vy + m[8] * vz;
    if (z <= 0.0001) return -1;
    const column = Math.floor(((x / ((z * tan * this.width) / this.height) + 1) * this.width) / 2),
      row = Math.floor(((1 - y / (z * tan)) * this.height) / 2);
    return column < 0 || row < 0 || column >= this.width || row >= this.height
      ? -1
      : row * this.width + column;
  }
  private reproject(pose: NonNullable<typeof this.pose>, now: number): void {
    const count = this.positions.length,
      colours = new Uint8ClampedArray(count * 4),
      sampled = new Float64Array(count).fill(-Infinity),
      world = new Float64Array(count * 3),
      sky = new Uint8Array(count),
      depths = new Float64Array(count).fill(Infinity);
    for (let i = 0; i < count; i++) {
      if (this.sampled[i] < now - 800) continue;
      const vx = this.world[i * 3] - (this.sky[i] ? 0 : pose.position[0]),
        vy = this.world[i * 3 + 1] - (this.sky[i] ? 0 : pose.position[1]),
        vz = this.world[i * 3 + 2] - (this.sky[i] ? 0 : pose.position[2]);
      const target = this.project(vx, vy, vz, pose);
      if (target < 0) continue;
      const depth = this.sky[i] ? Infinity : Math.hypot(vx, vy, vz);
      if (
        depth > depths[target] ||
        (depth === depths[target] && this.sampled[i] <= sampled[target])
      )
        continue;
      colours.set(this.colours.subarray(i * 4, i * 4 + 4), target * 4);
      world.set(this.world.subarray(i * 3, i * 3 + 3), target * 3);
      sampled[target] = this.sampled[i];
      sky[target] = this.sky[i];
      depths[target] = depth;
    }
    this.colours = colours;
    this.sampled = sampled;
    this.world = world;
    this.sky = sky;
  }
  render(
    now: number,
    reconstruct = true,
  ): { width: number; height: number; data: Uint8ClampedArray; mode: 'pose' | 'spatial' } {
    if (this.moving && now >= this.motionUntil) this.motion(false, now);
    // During motion use only recent rays and a 2x2 reconstruction grid. This trades
    // detail for coverage rather than mixing sharp samples from several old viewpoints.
    const scale = reconstruct && this.moving && !this.pose ? 2 : 1;
    const width = Math.ceil(this.width / scale),
      height = Math.ceil(this.height / scale),
      count = width * height;
    const data = new Uint8ClampedArray(count * 4);
    const nearest = new Int32Array(count).fill(-1),
      distance = new Uint8Array(count).fill(255);
    const cutoff = this.moving
      ? this.pose
        ? now - 800
        : Math.max(now - 300, this.latest - 50)
      : -Infinity;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const target = y * width + x,
          sums = [0, 0, 0];
        let samples = 0;
        for (let dy = 0; dy < scale && y * scale + dy < this.height; dy++)
          for (let dx = 0; dx < scale && x * scale + dx < this.width; dx++) {
            const source = (y * scale + dy) * this.width + x * scale + dx;
            if (this.sampled[source] === -Infinity || this.sampled[source] < cutoff) continue;
            for (let c = 0; c < 3; c++) sums[c] += this.colours[source * 4 + c];
            samples++;
          }
        if (!samples) continue;
        for (let c = 0; c < 3; c++) data[target * 4 + c] = Math.floor(sums[c] / samples);
        data[target * 4 + 3] = 255;
        nearest[target] = target;
        distance[target] = 0;
      }
    if (reconstruct) {
      // Bounded spatial hole filling in two linear passes. Real sampled pixels, including
      // genuine black surfaces, are never replaced. No full-image guessed background.
      const propagate = (to: number, from: number) => {
        if (distance[from] < 3 && distance[from] + 1 < distance[to]) {
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
        if (nearest[i] >= 0 && nearest[i] !== i)
          data.set(data.subarray(nearest[i] * 4, nearest[i] * 4 + 4), i * 4);
    }
    return { width, height, data, mode: this.pose ? 'pose' : 'spatial' };
  }
}
