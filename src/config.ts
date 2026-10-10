import 'dotenv/config';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);
const schema = z
  .object({
    DISCORD_TOKEN: z.string().min(20),
    DISCORD_CLIENT_ID: snowflake,
    DISCORD_GUILD_ID: snowflake,
    ADMIN_USER_ID: snowflake,
    RUST_SERVER_IP: z.string().regex(/^[a-zA-Z0-9.-]+$/),
    RUST_APP_PORT: z.coerce.number().int().min(1).max(65535),
    RUST_STEAM_ID: z.string().regex(/^\d{17}$/),
    RUST_PLAYER_TOKEN: z
      .string()
      .regex(/^-?\d+$/)
      .refine((s) => Number(s) >= -2147483648 && Number(s) <= 2147483647),
    RUST_USE_PROXY: z
      .enum(['true', 'false'])
      .default('true')
      .transform((s) => s === 'true'),
    DATABASE_PATH: z.string().default('./data/bot.sqlite'),
    ALLOWED_ROLE_IDS: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .pipe(z.array(snowflake)),
    ALERT_CHANNEL_ID: snowflake.optional(),
    ALERT_ROLE_ID: snowflake.optional(),
    BASE_NAME: z.string().min(1).max(80).default('Main Base'),
    ALARM_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(86400).default(60),
    CHAT_POLL_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
    RUST_CHAT_MAX_LENGTH: z.coerce.number().int().min(64).max(128).default(128),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine((value) => !value.ALLOWED_ROLE_IDS.includes(value.DISCORD_GUILD_ID), {
    path: ['ALLOWED_ROLE_IDS'],
    message: '@everyone cannot be an operator role',
  });
export type Config = z.infer<typeof schema>;
export function loadConfig(): Config {
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')),
  );
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return parsed.data;
}
