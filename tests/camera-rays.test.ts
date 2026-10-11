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
  expect(image.render(2001).width).toBe(4);
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
// Find a shuffled sample at a known screen coordinate independently of the pose math.
function centreSample() {
  for (let i = 0; i < 256; i++) {
    const image = new RayImage(16, 16);
    image.add(literal(i), 1000);
    if (image.render(1000, false).data[(8 * 16 + 8) * 4 + 3] === 255) return i;
  }
  throw new Error('Missing centre sample.');
}
function singlePoint() {
  const image = new RayImage(16, 16);
  // A non-zero known distance is required for drone translation tests.
  image.add(pose({ sampleOffset: centreSample(), rayData: Buffer.from([255, 128, 63, 3]) }), 1000);
  return image;
}
function point(image: RayImage, now: number) {
  const data = image.render(now, false).data;
  const index = Array.from(data).findIndex((v, i) => i % 4 === 3 && v === 255);
  return index < 0 ? -1 : (index - 3) / 4;
}
it('preserves stationary detail and reprojects a known point left when the camera pans right', () => {
  const image = singlePoint();
  expect(point(image, 1000)).toBe(8 * 16 + 8);
  image.motion(true, 1001);
  expect(image.render(1001).width).toBe(16);
  image.add(pose({ cameraRotation: { x: 0, y: 10, z: 0 } }), 1050);
  expect(image.render(1050).mode).toBe('pose');
  expect(point(image, 1050) % 16).toBeLessThan(8);
  expect(Math.floor(point(image, 1050) / 16)).toBe(8);
  image.motion(false, 1060);
  expect(visible(image.render(1060, false).data)).toBe(1);
});
it('reprojects drone translation, rejects points behind the camera and never extends sample age', () => {
  const image = singlePoint();
  image.add(pose({ cameraPosition: { x: 10, y: 0, z: 0 } }), 1100);
  expect(point(image, 1100) % 16).toBeLessThan(8);
  image.add(pose({ cameraPosition: { x: 11, y: 0, z: 0 } }), 1700);
  expect(visible(image.render(1700, false).data)).toBe(1);
  image.add(pose({ cameraPosition: { x: 12, y: 0, z: 0 } }), 1801);
  expect(visible(image.render(1801, false).data)).toBe(0);
  const turned = singlePoint();
  turned.add(pose({ cameraRotation: { x: 0, y: 180, z: 0 } }), 1100);
  expect(visible(turned.render(1100, false).data)).toBe(0);
});
it('places jittered samples in the display orientation and handles FOV changes', () => {
  const image = new RayImage(16, 16);
  image.add(
    pose({
      sampleOffset: centreSample(),
      rayData: Buffer.from([255, 128, 63, 3]),
      sampleRotation: { x: 0, y: 10, z: 0 },
    }),
    1000,
  );
  expect(point(image, 1000) % 16).toBeGreaterThan(8);
  const before = point(image, 1000) % 16;
  image.add(pose({ verticalFov: 60 }), 1100);
  expect(point(image, 1100) % 16).toBeGreaterThanOrEqual(before);
});
it('falls back safely on missing or invalid pose, clearing incompatible accumulated samples', () => {
  const image = singlePoint();
  image.add(literal(0), 1100);
  expect(image.render(1100, false).mode).toBe('spatial');
  expect(visible(image.render(1100, false).data)).toBe(1);
  image.add(pose({ cameraPosition: { x: NaN, y: 0, z: 0 }, ...literal(1) }), 1200);
  expect(image.render(1200, false).mode).toBe('spatial');
  image.add(pose({ ...literal(2) }), 1300);
  expect(image.render(1300, false).mode).toBe('pose');
  expect(visible(image.render(1300, false).data)).toBe(1);
});
it('uses the newest packet window while moving without pose, rather than mixing older views', () => {
  const image = new RayImage(8, 8);
  image.motion(true, 1000);
  image.add(literal(0), 1001);
  image.add(literal(1), 1100);
  expect(visible(image.render(1100, false).data)).toBe(1);
});
