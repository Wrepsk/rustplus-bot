import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RayImage } from '../src/cameras/ray-image';
import type { CameraRays } from '../src/rust/protocol';

// Only test fixtures are decoded as image files; production encodes raw bitmaps only.
const upstream = createRequire(require.resolve('@liamcottle/rustplus.js'));
const Jimp = upstream('jimp') as {
  read: (data: Buffer) => Promise<{ bitmap: { width: number; height: number; data: Buffer } }>;
};
const literal = (offset: number, alignment = 63, material = 3) => ({
  sampleOffset: offset,
  rayData: Buffer.from([255, 0, alignment, material]),
});
const visible = (data: Uint8ClampedArray) =>
  Array.from(data).filter((_, i) => i % 4 === 3 && data[i] === 255).length;

it('matches public captured Rust rays against the reference golden image', async () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/camera/cam02-frames.json', 'utf8')) as {
    Width: number;
    Height: number;
    Frames: { SampleOffset: number; RayDataBase64: string }[];
  };
  const image = new RayImage(fixture.Width, fixture.Height);
  for (const frame of fixture.Frames)
    image.add(
      { sampleOffset: frame.SampleOffset, rayData: Buffer.from(frame.RayDataBase64, 'base64') },
      1000,
    );
  const expected = await Jimp.read(readFileSync('tests/fixtures/camera/cam02-golden.png'));
  const actual = image.render(1000, false);
  expect([actual.width, actual.height]).toEqual([expected.bitmap.width, expected.bitmap.height]);
  let mismatched = 0;
  for (let i = 0; i < actual.data.length; i++)
    if (Math.abs(actual.data[i] - expected.bitmap.data[i]) > (i % 4 === 3 ? 0 : 1)) mismatched++;
  expect(mismatched).toBe(0);
});
it('retains a complete stationary sweep across more than ten packets instead of making holes', () => {
  const image = new RayImage(8, 8);
  for (let i = 0; i < 64; i++) image.add(literal(i), 1000 + i);
  expect(visible(image.render(1100, false).data)).toBe(64);
  for (let i = 0; i < 20; i++) image.add(literal(i), 2000 + i);
  expect(visible(image.render(2100, false).data)).toBe(64);
});
it('fills only small unsampled gaps without replacing genuine black samples', () => {
  const image = new RayImage(8, 8);
  image.add(literal(0, 0), 1000);
  const native = image.render(1000, false),
    smooth = image.render(1000);
  const pixel =
    Array.from(native.data).findIndex((value, index) => index % 4 === 3 && value === 255) - 3;
  expect(Array.from(smooth.data.slice(pixel, pixel + 4))).toEqual([0, 0, 0, 255]);
  expect(visible(smooth.data)).toBeGreaterThan(1);
  expect(visible(smooth.data)).toBeLessThan(64);
});
it('clears the old view on movement, expires old motion samples and rebuilds detail after stopping', () => {
  const image = new RayImage(8, 8);
  for (let i = 0; i < 64; i++) image.add(literal(i), 1000);
  image.motion(true, 2000);
  image.add(literal(1), 1999); // Packets queued before the movement must not restore the old view.
  expect(visible(image.render(2000, false).data)).toBe(0);
  image.add(literal(2), 2001);
  expect(image.render(2001).width).toBe(8);
  expect(visible(image.render(2001, false).data)).toBe(1);
  image.motion(true, 2300); // Heartbeats don't repeatedly erase current samples.
  expect(visible(image.render(2300, false).data)).toBe(1);
  expect(visible(image.render(2302, false).data)).toBe(0);
  image.motion(false, 2400);
  image.add(literal(3), 2401);
  expect(image.render(2401).width).toBe(8);
  expect(visible(image.render(2401, false).data)).toBe(1);
});
it('rejects truncated packets and out-of-range metadata with bounded allocations', () => {
  const image = new RayImage(4, 4);
  expect(() => image.add({ sampleOffset: 0, rayData: Buffer.from([255, 0]) }, 1000)).toThrow(
    'Truncated',
  );
  expect(() => image.add(literal(-1), 1000)).toThrow('Invalid');
  expect(() => new RayImage(1e6, 1e6)).toThrow('dimensions');
});

const pose = (overrides: Partial<CameraRays> = {}): CameraRays => ({
  sampleOffset: 0,
  rayData: Buffer.alloc(0),
  verticalFov: 90,
  distance: 100,
  cameraPosition: { x: 0, y: 0, z: 0 },
  cameraRotation: { x: 0, y: 0, z: 0 },
  ...overrides,
});
it('keeps verified sample coordinates despite changing or invalid pose and sampling metadata', () => {
  const reference = new RayImage(16, 16),
    image = new RayImage(16, 16);
  for (let i = 0; i < 64; i++) {
    const frame = literal(i);
    reference.add(frame, 1000 + i);
    image.add(
      pose({
        ...frame,
        cameraPosition: { x: i * 10, y: 0, z: NaN },
        cameraRotation: { x: i * 90, y: 360 - i, z: 0 },
        sampleRotation: { x: 0, y: -i * 40, z: 0 },
        verticalFov: i % 2 ? 60 : 90,
      }),
      1000 + i,
    );
    expect(image.render(1000 + i, false).data).toEqual(reference.render(1000 + i, false).data);
  }
  expect(image.render(1100).mode).toBe('spatial');
});
it('preserves stationary coverage while metadata appears, disappears or changes', () => {
  const image = new RayImage(8, 8);
  for (let i = 0; i < 64; i++) image.add({ ...pose(), ...literal(i) }, 1000);
  image.add(literal(0), 1100);
  image.add({ ...pose({ cameraRotation: { x: NaN, y: 0, z: 0 } }), ...literal(1) }, 1200);
  expect(visible(image.render(1200, false).data)).toBe(64);
});
it('reduces sparse moving-image holes with bounded spatial reconstruction at fixed native dimensions', () => {
  const image = new RayImage(160, 90);
  image.motion(true, 1000);
  for (let i = 0; i < 1000; i++) image.add({ ...pose(), ...literal(i) }, 1001);
  const raw = image.render(1001, false),
    smooth = image.render(1001);
  expect([smooth.width, smooth.height]).toEqual([160, 90]);
  expect(visible(raw.data)).toBe(1000);
  expect(visible(smooth.data)).toBeGreaterThan(160 * 90 * 0.99);
  // Reconstruction cannot revive expired samples or invent coverage with no rays.
  expect(visible(image.render(1302).data)).toBe(0);
  image.motion(false, 1400);
  image.add(literal(1), 1401);
  expect([image.render(1401).width, image.render(1401).height]).toEqual([160, 90]);
});
it('retains a short recent packet window during movement instead of only one packet', () => {
  const image = new RayImage(8, 8);
  image.motion(true, 1000);
  image.add(literal(0), 1001);
  image.add(literal(1), 1100);
  expect(visible(image.render(1100, false).data)).toBe(2);
  image.add(literal(2), 1200);
  expect(visible(image.render(1200, false).data)).toBe(2);
});
it('interpolates moving-image colours without painting unsampled areas black or erasing actual black regions', () => {
  const image = new RayImage(16, 16);
  image.motion(true, 1000);
  for (let i = 0; i < 256; i++) image.add(literal(i, i % 2 ? 63 : 0), 1001);
  const data = image.render(1001).data;
  expect(visible(data)).toBe(256);
  expect(Array.from(data).some((v, i) => i % 4 === 0 && v > 0 && v < 153)).toBe(true);
  const black = new RayImage(16, 16);
  black.motion(true, 1000);
  for (let i = 0; i < 256; i++) black.add(literal(i, 0), 1001);
  expect(black.render(1001).data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0))).toBe(true);
});
