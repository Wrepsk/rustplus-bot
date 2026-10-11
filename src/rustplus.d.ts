declare module '@liamcottle/rustplus.js' {
  import { EventEmitter } from 'node:events';
  class RustPlus extends EventEmitter {
    constructor(
      server: string,
      port: number,
      playerId: string,
      playerToken: string,
      proxy?: boolean,
    );
    connect(): void;
    disconnect(): void;
    seq: number;
    AppMessage: import('protobufjs').Type;
    seqCallbacks: ((message: import('./rust/protocol').RustMessage) => boolean)[];
    websocket?: { terminate(): void } | null;
    sendRequest(
      request: import('./rust/protocol').RustRequest,
      callback: (message: import('./rust/protocol').RustMessage) => boolean,
    ): void;
  }
  export = RustPlus;
}
