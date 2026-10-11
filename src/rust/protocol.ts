import type { EventEmitter } from 'node:events';
import type { TeamMessage } from '../domain';

export class ProtocolDecodeFailure extends Error {
  readonly code = 'RUST_PROTOCOL_DECODE';
  constructor(readonly schemaField?: string) {
    super('Rust+ message decoding failed.');
  }
}

export interface RustResponse {
  seq: number;
  error?: { error: string };
  success?: object;
  info?: { name: string; players: number; maxPlayers: number };
  entityInfo?: { type: number; payload: { value?: boolean } };
  teamChat?: { messages: TeamMessage[] };
  teamInfo?: {
    leaderSteamId: { toString(): string };
    // AppTeamInfo.Member fields verified in the installed rustplus.proto.
    members: { steamId: { toString(): string }; name: string; isOnline?: boolean }[];
  };
}
export interface RustMessage {
  response?: RustResponse;
  broadcast?: {
    entityChanged?: { entityId: number; payload: { value?: boolean } };
    teamMessage?: { message: TeamMessage };
    teamChanged?: { teamInfo: NonNullable<RustResponse['teamInfo']> };
  };
}
export interface RustRequest {
  entityId?: number;
  getInfo?: object;
  getTeamInfo?: object;
  getTeamChat?: object;
  getEntityInfo?: object;
  setEntityValue?: { value: boolean };
  sendTeamMessage?: { message: string };
}
export interface RustClient extends EventEmitter {
  connect(): void;
  disconnect(): void;
  sendRequest(request: RustRequest, callback: (message: RustMessage) => boolean): void;
  // Verified upstream fields: used to remove timed-out callbacks and cancel late connects.
  seq: number;
  seqCallbacks: ((message: RustMessage) => boolean)[];
  websocket?: { terminate(): void } | null;
}
