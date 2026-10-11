import { Worker } from 'node:worker_threads';
import type { CameraInfo, CameraRays } from '../rust/protocol';

// Use the installed library's verified decoder, isolated from alarms/chat on the main event loop.
// Its public Camera lifecycle creates async intervals/listeners; only its pure PNG renderer is used.
const source = `
const {parentPort, workerData} = require('node:worker_threads');
const Camera = require(workerData.module);
// PNG encoding is for live frames, not archival compression. Worker-local only.
const {createRequire} = require('node:module');
const Jimp = createRequire(workerData.module)('jimp');
Jimp.prototype._deflateLevel = 1;
parentPort.on('message', async ({frames, width, height}) => {
  try {
    const png = await Camera.prototype._renderCameraFrame(frames, width, height);
    parentPort.postMessage({png});
  } catch { parentPort.postMessage({error:true}); }
});`;
export class CameraRenderer {
  private worker?: Worker;
  private frames: CameraRays[] = [];
  private busy = false;
  private lastRender = 0;
  private timer?: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;
  private dirty = false;
  private stopped = false;
  constructor(
    private info: CameraInfo,
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
      workerData: { module: require.resolve('@liamcottle/rustplus.js/camera') },
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
    this.frames.push({ sampleOffset: frame.sampleOffset, rayData: frame.rayData });
    if (this.frames.length > 10) this.frames.shift();
    this.dirty = true;
    this.schedule();
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
      width: this.info.width,
      height: this.info.height,
    });
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
