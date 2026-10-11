import { z } from 'zod';

export const listenerSchema = z.object({
  androidId: z.string().regex(/^\d{1,20}$/),
  securityToken: z.string().regex(/^\d{1,20}$/),
});
export type ListenerCredentials = z.infer<typeof listenerSchema>;
const endpoint = {
  ip: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/),
  port: z.coerce.number().int().min(1).max(65535),
};
export const serverPairingSchema = z.object({
  type: z.literal('server'),
  ...endpoint,
  name: z.string().min(1).max(200),
  playerId: z.string().regex(/^\d{17}$/),
  playerToken: z.coerce
    .string()
    .regex(/^-?\d+$/)
    .refine((v) => Number(v) >= -2147483648 && Number(v) <= 2147483647),
});
export const entityPairingSchema = z.object({
  type: z.literal('entity'),
  ...endpoint,
  entityId: z.coerce
    .string()
    .regex(/^\d{1,10}$/)
    .refine((v) => Number(v) > 0 && Number(v) <= 4294967295),
  entityType: z.coerce.number().int().min(1).max(2),
  entityName: z.string().max(200).optional(),
});
export const pairingSchema = z.discriminatedUnion('type', [
  serverPairingSchema,
  entityPairingSchema,
]);
export type Pairing = z.infer<typeof pairingSchema>;

const deathPushSchema = z.object({ type: z.literal('death'), ...endpoint });
export interface DeathPush {
  ip: string;
  port: number;
  title: string;
  message: string;
  persistentId?: string;
}
// Verified Rust+ push channel: player / body.type=death. targetId is NOT
// assumed to be the victim; the receiving linked account identifies the player.
export function parseDeathPush(input: unknown): DeathPush | null {
  try {
    const raw = z
      .object({
        persistentId: z.string().min(1).max(200).optional(),
        appData: z
          .array(z.object({ key: z.string().max(100), value: z.string().max(16384) }))
          .max(50),
      })
      .parse(input);
    const data = Object.fromEntries(raw.appData.map((entry) => [entry.key, entry.value]));
    if (data.channelId !== 'player' || !data.body) return null;
    const body = deathPushSchema.parse(JSON.parse(data.body));
    if ((data.title?.length || 0) > 256 || (data.message?.length || 0) > 1024) return null;
    return {
      ip: body.ip,
      port: body.port,
      title: data.title || '',
      message: data.message || '',
      persistentId: raw.persistentId,
    };
  } catch {
    return null;
  }
}

// FCM's appData contains string key/value pairs; body is itself JSON.
export function parsePairing(input: unknown): Pairing | null {
  try {
    const message = z
      .object({ appData: z.array(z.object({ key: z.string(), value: z.string() })).max(50) })
      .parse(input);
    const data = Object.fromEntries(message.appData.map((a) => [a.key, a.value]));
    if (data.channelId !== 'pairing' || !data.body || data.body.length > 16384) return null;
    return pairingSchema.parse(JSON.parse(data.body));
  } catch {
    return null;
  }
}
