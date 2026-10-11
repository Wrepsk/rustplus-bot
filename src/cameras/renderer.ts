import { Worker } from 'node:worker_threads';
import type { CameraInfo, CameraRays } from '../rust/protocol';
import { RayImage } from './ray-image';

// Keep decoding/PNG work isolated from alarms and chat. Serialize our self-contained,
// tested codec so workers work both from TypeScript tests and compiled production files.
const source = `
const {parentPort, workerData} = require('node:worker_threads');
const {createRequire} = require('node:module');
const Jimp = createRequire(workerData.module)('jimp');
// esbuild uses this name helper in test transforms; production TypeScript needs none.
const __name = value => value;
const RayImage = (${RayImage.toString()});
const image = new RayImage(workerData.width, workerData.height);
parentPort.on('message', async ({frames, motion}) => {
  try {
    if (motion) { image.motion(motion.active, motion.at); return; }
    for (const frame of frames) image.add(frame, frame.at);
    const bitmap = image.render(Date.now());
    const png = await new Jimp({data:Buffer.from(bitmap.data), width:bitmap.width, height:bitmap.height}).deflateLevel(1).getBufferAsync(Jimp.MIME_PNG);
    parentPort.postMessage({png});
  } catch { parentPort.postMessage({error:true}); }
});`;
export class CameraRenderer {
  private worker?: Worker;
  private frames: (CameraRays & { at: number })[] = [];
  private pendingBytes = 0;
  private busy = false;
  private lastRender = 0;
  private timer?: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;
  private dirty = false;
  private stopped = false;
  constructor(
    info: CameraInfo,
    private output: (png: Buffer) => void,
    private failed: () => void,
  ) {
    if (
      !Number.isInteger(info.width) ||
      !Number.isInteger(info.height) ||
      info.width < 1 ||
      info.height < 1 ||
      info.width > 512 ||
      info.height > 512
    )
      throw new Error('Unsupported camera dimensions.');
    this.worker = new Worker(source, {
      eval: true,
      workerData: {
        module: require.resolve('@liamcottle/rustplus.js/camera'),
        width: info.width,
        height: info.height,
      },
      resourceLimits: { maxOldGenerationSizeMb: 96 },
    });
    this.worker.on('message', (result: { png?: Uint8Array; error?: boolean }) => {
      if (this.timer) clearTimeout(this.timer);
      this.busy = false;
      if (this.stopped) return;
      if (!result.png || result.png.byteLength > 2097152) {
        this.fail();
        return;
      }
      this.output(Buffer.from(result.png));
      this.schedule();
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => {
      if (!this.stopped) this.fail();
    });
  }
  push(frame: CameraRays): void {
    if (this.stopped) return;
    if (
      !(frame.rayData instanceof Uint8Array) ||
      frame.rayData.byteLength > 65536 ||
      !Number.isInteger(frame.sampleOffset) ||
      frame.sampleOffset < 0 ||
      frame.sampleOffset > 2147483647
    ) {
      this.fail();
      return;
    }
    this.frames.push({ sampleOffset: frame.sampleOffset, rayData: frame.rayData, at: Date.now() });
    this.pendingBytes += frame.rayData.byteLength;
    // Queue only undecoded packets. The worker retains a fixed per-pixel cache,
    // rather than throwing away image coverage each time ten packets roll over.
    while (this.frames.length > 64 || this.pendingBytes > 1048576)
      this.pendingBytes -= this.frames.shift()!.rayData.byteLength;
    this.dirty = true;
    this.schedule();
  }
  motion(active: boolean): void {
    if (!this.stopped) this.worker?.postMessage({ motion: { active, at: Date.now() } });
  }
  private schedule(): void {
    if (this.stopped || this.busy || this.scheduled || !this.dirty) return;
    const wait = Math.max(0, this.lastRender + 100 - Date.now());
    if (wait) {
      this.scheduled = setTimeout(() => {
        this.scheduled = undefined;
        this.schedule();
      }, wait);
      return;
    }
    this.dirty = false;
    this.lastRender = Date.now();
    this.busy = true;
    this.timer = setTimeout(() => this.fail(), 5000);
    this.worker?.postMessage({
      frames: this.frames,
    });
    this.frames = [];
    this.pendingBytes = 0;
  }
  private fail(): void {
    if (!this.stopped) {
      this.stop();
      this.failed();
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled);
    this.frames = [];
    void this.worker?.terminate();
    this.worker = undefined;
  }
}
