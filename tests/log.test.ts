import { describe, expect, it } from 'vitest';
import { transportErrorDetails } from '../src/log';
import { ProtocolDecodeFailure } from '../src/rust/protocol';

describe('safe Rust+ transport diagnostics', () => {
  it('reports only trusted schema metadata for protocol errors', () => {
    expect(transportErrorDetails(new ProtocolDecodeFailure('rustplus.AppResponse.seq'))).toEqual({
      reason: 'protobuf_decode_failed',
      schemaField: 'rustplus.AppResponse.seq',
    });
    expect(
      transportErrorDetails({ code: 'RUST_PROTOCOL_DECODE', schemaField: 'secret-token' }),
    ).toEqual({
      reason: 'protobuf_decode_failed',
    });
  });
  it.each([403, 502, 503])('reports a rejected WebSocket upgrade (%s)', (httpStatus) => {
    expect(transportErrorDetails(new Error(`Unexpected server response: ${httpStatus}`))).toEqual({
      reason: 'websocket_upgrade_rejected',
      httpStatus,
    });
  });
  it.each([
    ['ECONNREFUSED', 'connection_refused'],
    ['ENOTFOUND', 'dns_lookup_failed'],
    ['CERT_HAS_EXPIRED', 'tls_certificate_expired'],
  ])('classifies %s without forwarding the upstream message', (code, reason) => {
    expect(
      transportErrorDetails({ code, message: 'secret-token https://private.example' }),
    ).toEqual({ reason });
  });
  it('identifies WebSocket handshake timeouts', () => {
    expect(transportErrorDetails(new Error('Opening handshake has timed out'))).toEqual({
      reason: 'websocket_handshake_timed_out',
    });
  });
  it.each([
    null,
    'secret-token',
    { code: 'secret-token', message: 'secret-token' },
    new Error('Unexpected server response: 502 https://private.example?token=secret'),
  ])('never includes arbitrary error fields or raw messages', (error) => {
    expect(transportErrorDetails(error)).toEqual({ reason: 'unknown_transport_error' });
  });
});
