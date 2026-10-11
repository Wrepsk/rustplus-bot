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
  cameraSubscribeInfo?: CameraInfo;
  teamInfo?: {
    leaderSteamId: { toString(): string };
    // AppTeamInfo.Member fields verified in the installed rustplus.proto.
    members: {
      steamId: { toString(): string };
      name: string;
      isOnline?: boolean;
      isAlive?: boolean;
    }[];
  };
}
export interface RustMessage {
  response?: RustResponse;
  broadcast?: {
    entityChanged?: { entityId: number; payload: { value?: boolean } };
    teamMessage?: { message: TeamMessage };
    teamChanged?: { teamInfo: NonNullable<RustResponse['teamInfo']> };
    cameraRays?: CameraRays;
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
  cameraSubscribe?: { cameraId: string };
  cameraUnsubscribe?: object;
  cameraInput?: { buttons: number; mouseDelta: { x: number; y: number } };
}
export interface CameraInfo {
  width: number;
  height: number;
  nearPlane: number;
  farPlane: number;
  controlFlags: number;
}
export interface CameraRays {
  sampleOffset: number;
  rayData: Uint8Array;
  verticalFov?: number;
  distance?: number;
  cameraPosition?: { x: number; y: number; z: number };
  cameraRotation?: { x: number; y: number; z: number };
  sampleRotation?: { x: number; y: number; z: number };
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
