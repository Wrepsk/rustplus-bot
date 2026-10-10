import { z } from 'zod';

export const deviceSchema = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .refine((s) => Number(s) <= 4294967295, 'Entity ID must fit uint32'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine((s) => !/[\r\n\x00-\x1f]/.test(s), 'Use a single-line name'),
  type: z.enum(['switch', 'alarm']),
  sensitive: z.boolean().default(false),
});
export type Device = z.infer<typeof deviceSchema> & { enabled: boolean };
export function needsConfirmation(device: Pick<Device, 'name' | 'sensitive'>): boolean {
  return (
    device.sensitive ||
    /explos|destruct|detonat|rocket|c4|satchel|bomb|mine|incendiary/i.test(device.name)
  );
}
export class ExpiringSet {
  private values = new Map<string, number>();
  constructor(
    private ttl = 120_000,
    private limit = 5000,
  ) {}
  has(key: string, now = Date.now()): boolean {
    this.prune(now);
    return this.values.has(key);
  }
  add(key: string, now = Date.now()): void {
    this.prune(now);
    this.values.set(key, now + this.ttl);
    if (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!);
  }
  private prune(now: number): void {
    for (const [key, expiry] of this.values) if (expiry <= now) this.values.delete(key);
  }
}
export class AlarmTransitions {
  private states = new Map<string, boolean>();
  constructor(
    private cooldownMs: number,
    private last: (id: string) => number,
    private save: (id: string, at: number) => void,
  ) {}
  reset(): void {
    this.states.clear();
  }
  sync(id: string, value: boolean): void {
    this.states.set(id, value);
  }
  change(id: string, value: boolean, enabled: boolean, now = Date.now()): boolean {
    const previous = this.states.get(id);
    this.states.set(id, value);
    if (previous !== false || !value || !enabled || now - this.last(id) < this.cooldownMs)
      return false;
    this.save(id, now);
    return true;
  }
}
export function plainText(text: string): string {
  return text
    .replace(/<@!?\d+>/g, '@user')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:([\w]+):\d+>/g, ':$1:')
    .replace(/@(everyone|here)/gi, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`|]/g, '')
    .replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function chatChunks(name: string, content: string, max = 128): string[] {
  const body = plainText(content);
  if (!body) return [];
  const prefix = `[Discord] ${Array.from(plainText(name)).slice(0, 24).join('')}: `;
  const points = Array.from(body),
    room = max - prefix.length,
    result: string[] = [];
  // Count UTF-16 units conservatively, so astral characters cannot exceed the server limit.
  let chunk = '';
  for (const point of points) {
    if (chunk.length + point.length > room) {
      result.push(prefix + chunk);
      chunk = '';
    }
    chunk += point;
  }
  if (chunk) result.push(prefix + chunk);
  return result;
}
export interface TeamMessage {
  steamId: { toString(): string } | string;
  name: string;
  message: string;
  time: number;
}
export function messageKey(message: TeamMessage): string {
  return `${message.steamId.toString()}:${message.time}:${message.message}`;
}
export function isEcho(message: TeamMessage, playerId: string, sent: ExpiringSet): boolean {
  return message.steamId.toString() === playerId && sent.has(message.message);
}
