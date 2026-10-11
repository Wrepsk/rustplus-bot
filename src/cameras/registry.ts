import { z } from 'zod';
import type { Store } from '../database';

export class CameraError extends Error {}
export const cameraSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .refine((v) => !/[\u0000-\u001f\u007f]/.test(v)),
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .refine((v) => !/[\u0000-\u001f\u007f]/.test(v)),
  })
  .strict();
export type RegisteredCamera = z.infer<typeof cameraSchema>;
export class CameraRegistry {
  constructor(private store: Store) {}
  list(): RegisteredCamera[] {
    return this.store.get('cameras', []);
  }
  get(id: string): RegisteredCamera {
    const camera = this.list().find((c) => c.id === id);
    if (!camera) throw new CameraError('Choose a registered camera from /camera list.');
    return camera;
  }
  add(input: unknown): void {
    const parsed = cameraSchema.safeParse(input);
    if (!parsed.success)
      throw new CameraError(
        'Use a 1–32 character camera identifier and a 1–60 character name, without control characters.',
      );
    if (this.list().some((c) => c.id === parsed.data.id))
      throw new CameraError('That camera is already registered. Remove it first to rename it.');
    if (this.list().length >= 25) throw new CameraError('Maximum 25 cameras per server.');
    this.store.set('cameras', [...this.list(), parsed.data]);
  }
  remove(id: string): void {
    this.get(id);
    this.store.set(
      'cameras',
      this.list().filter((c) => c.id !== id),
    );
  }
}

// Verified rustplus.js Camera.Buttons / ControlFlags. FIRE and RELOAD are deliberately absent.
export function movement(
  action: string,
  flags: number,
): { buttons: number; mouseDelta: { x: number; y: number } } {
  const input = { buttons: 0, mouseDelta: { x: 0, y: 0 } };
  if (action === 'release') return input;
  const flight: Record<string, number> = {
    forward: 2,
    back: 4,
    left: 8,
    right: 16,
    up: 32,
    down: 64,
  };
  const look: Record<string, [number, number]> = {
    'look-left': [-5, 0],
    'look-right': [5, 0],
    'look-up': [0, -5],
    'look-down': [0, 5],
  };
  if (Object.hasOwn(flight, action) && flags & 1 && (action !== 'down' || flags & 4))
    input.buttons = flight[action];
  else if (Object.hasOwn(look, action) && flags & 2)
    [input.mouseDelta.x, input.mouseDelta.y] = look[action];
  else throw new CameraError('This movement is unavailable for this camera.');
  return input;
}
