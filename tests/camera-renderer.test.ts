import { expect, it } from 'vitest';
import { CameraRenderer } from '../src/cameras/renderer';

it('renders synthetic rays using the installed Rust+ decoder in a worker', async () => {
  let renderer: CameraRenderer | undefined;
  try {
    const png = await new Promise<Buffer>((resolve, reject) => {
      renderer = new CameraRenderer(
        { width: 4, height: 4, nearPlane: 0, farPlane: 100, controlFlags: 0 },
        resolve,
        () => reject(new Error('Render failed.')),
      );
      for (let i = 0; i < 10; i++)
        renderer.push({ sampleOffset: i * 100, rayData: Buffer.from([0, 0, 0, 0]) });
    });
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  } finally {
    renderer?.stop();
  }
});
it('rejects excessive dimensions before creating a worker', () => {
  expect(
    () =>
      new CameraRenderer(
        { width: 100000, height: 4, nearPlane: 0, farPlane: 100, controlFlags: 0 },
        () => {},
        () => {},
      ),
  ).toThrow('dimensions');
});
