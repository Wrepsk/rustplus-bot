import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { registerCompanion } from '../src/pairing/registration';

vi.mock('node:worker_threads', () => ({
  Worker: vi.fn(
    class extends EventEmitter {
      stdout = new PassThrough();
      stderr = new PassThrough();
      terminate = vi.fn(async () => 0);
    },
  ),
}));
type FakeWorker = EventEmitter & {
  terminate: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  stderr: PassThrough;
};
function worker(): FakeWorker {
  return vi.mocked(Worker).mock.results.at(-1)!.value as FakeWorker;
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('bounded companion registration workers', () => {
  it('returns only validated FCM credentials and terminates the worker', async () => {
    const pending = registerCompanion('synthetic-token', new AbortController().signal);
    const instance = worker();
    instance.stdout.write('private upstream token output');
    instance.stderr.write('private upstream error output');
    instance.emit('message', { androidId: '123', securityToken: '456' });
    await expect(pending).resolves.toEqual({ androidId: '123', securityToken: '456' });
    expect(instance.terminate).toHaveBeenCalledOnce();
    instance.emit('exit', 0);
    expect(instance.terminate).toHaveBeenCalledOnce();
  });
  it('enforces a hard deadline even if upstream requests never finish', async () => {
    vi.useFakeTimers();
    const pending = registerCompanion('synthetic-token', new AbortController().signal);
    const result = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(60000);
    await result;
    expect(worker().terminate).toHaveBeenCalledOnce();
  });
  it('terminates registration on shutdown and refuses pre-aborted work', async () => {
    const controller = new AbortController();
    const pending = registerCompanion('synthetic-token', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('failed or timed out');
    expect(worker().terminate).toHaveBeenCalledOnce();
    vi.mocked(Worker).mockClear();
    await expect(registerCompanion('synthetic-token', controller.signal)).rejects.toThrow(
      'stopped',
    );
    expect(Worker).not.toHaveBeenCalled();
  });
  it('hides raw errors and rejects malformed worker results', async () => {
    const pending = registerCompanion('synthetic-token', new AbortController().signal);
    worker().emit('error', new Error('sensitive authToken in upstream response'));
    await expect(pending).rejects.toThrow(/^Companion registration failed or timed out/);
    const malformed = registerCompanion('synthetic-token', new AbortController().signal);
    worker().emit('message', { androidId: 'not-an-id', securityToken: 'private' });
    await expect(malformed).rejects.toThrow(/^Companion registration failed/);
  });
});
