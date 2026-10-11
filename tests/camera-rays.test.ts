import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RayImage } from '../src/cameras/ray-image';

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
