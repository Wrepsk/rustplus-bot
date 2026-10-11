import pino from 'pino';
import { ProtocolDecodeFailure } from './rust/protocol';
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

// Extract only known transport diagnostics; upstream messages can contain secrets or URLs.
export function transportErrorDetails(error: unknown): {
  reason: string;
  httpStatus?: number;
  schemaField?: string;
} {
  if (error instanceof ProtocolDecodeFailure)
    return {
      reason: 'protobuf_decode_failed',
      ...(error.schemaField ? { schemaField: error.schemaField } : {}),
    };
  if (typeof error !== 'object' || error === null) return { reason: 'unknown_transport_error' };
  const details = error as { code?: unknown; message?: unknown };
  const reasons: Record<string, string> = {
    ENOTFOUND: 'dns_lookup_failed',
    EAI_AGAIN: 'dns_temporarily_unavailable',
    ECONNREFUSED: 'connection_refused',
    ECONNRESET: 'connection_reset',
    ETIMEDOUT: 'connection_timed_out',
    ENETUNREACH: 'network_unreachable',
    EHOSTUNREACH: 'host_unreachable',
    CERT_HAS_EXPIRED: 'tls_certificate_expired',
    ERR_TLS_CERT_ALTNAME_INVALID: 'tls_hostname_mismatch',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_certificate_untrusted',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_certificate_untrusted',
    RUST_PROTOCOL_DECODE: 'protobuf_decode_failed',
  };
  if (typeof details.code === 'string' && Object.hasOwn(reasons, details.code))
    return { reason: reasons[details.code] };
  if (typeof details.message === 'string') {
    const http = /^Unexpected server response: ([1-5]\d{2})$/.exec(details.message);
    if (http) return { reason: 'websocket_upgrade_rejected', httpStatus: Number(http[1]) };
    if (details.message === 'Opening handshake has timed out')
      return { reason: 'websocket_handshake_timed_out' };
  }
  return { reason: 'unknown_transport_error' };
}
