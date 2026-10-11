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
      // One ray packet must be enough to display a partial image; never wait for ten packets.
      renderer.push({ sampleOffset: 0, rayData: Buffer.from([0, 0, 0, 0]) });
    });
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  } finally {
    renderer?.stop();
  }
});
it('renders the latest burst after a busy worker finishes, without needing another ray packet', async () => {
  let renderer: CameraRenderer | undefined;
  let count = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      renderer = new CameraRenderer(
        { width: 320, height: 180, nearPlane: 0, farPlane: 100, controlFlags: 0 },
        () => {
          if (++count === 2) resolve();
        },
        () => reject(new Error('Render failed.')),
      );
      for (let i = 0; i < 30; i++) renderer.push({ sampleOffset: i, rayData: Buffer.from([0, 0]) });
    });
    expect(count).toBe(2);
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
