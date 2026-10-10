import pino from 'pino';
// Never log protocol packets, environment values, URLs or raw upstream errors.
export const log = pino({
  level: ['debug', 'info', 'warn', 'error'].includes(process.env.LOG_LEVEL || '')
    ? process.env.LOG_LEVEL
    : 'info',
  redact: ['token', 'playerToken', 'password', 'authorization'],
});
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error)
    return String(error.code)
      .replace(/[^\w-]/g, '')
      .slice(0, 40);
  return error instanceof Error ? error.name : 'UnknownError';
}
