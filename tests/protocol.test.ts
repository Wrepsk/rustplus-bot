import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import { Connection } from '../src/rust/connection';
import type { TeamMessage } from '../src/domain';

const libraryPath = require.resolve('@liamcottle/rustplus.js');
const upstreamRequire = createRequire(libraryPath);
const protobuf = upstreamRequire('protobufjs') as typeof import('protobufjs');

describe('installed rustplus.js protocol compatibility', () => {
  it('authenticates, reads and controls switches, and decodes alarm/chat broadcasts over a local mock socket', async () => {
    const root = await protobuf.load(join(dirname(libraryPath), 'rustplus.proto'));
    const requestType = root.lookupType('rustplus.AppRequest'),
      messageType = root.lookupType('rustplus.AppMessage');
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('No mock server address');
    const requests: Record<string, unknown>[] = [];
    let peer: WebSocket | undefined;
    let switchValue = false;
    const send = (message: Record<string, unknown>) =>
      peer!.send(messageType.encode(messageType.fromObject(message)).finish());
    server.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (bytes) => {
        const request = requestType.toObject(requestType.decode(Buffer.from(bytes as Buffer)), {
          longs: String,
        });
        requests.push(request);
        const response: Record<string, unknown> = { seq: request.seq };
        if (request.getInfo)
          response.info = {
            name: 'Local Protocol Test',
            headerImage: '',
            url: '',
            map: 'Procedural Map',
            mapSize: 4000,
            wipeTime: 0,
            players: 3,
            maxPlayers: 100,
            queuedPlayers: 0,
          };
        else if (request.getEntityInfo)
          response.entityInfo = {
            type: request.entityId === 42 ? 1 : 2,
            payload: { value: request.entityId === 42 ? switchValue : false },
          };
        else if (request.getTeamChat)
          response.teamChat = {
            messages: [
              {
                steamId: '76561198000000001',
                name: 'Hakan',
                message: 'Got sulfur?',
                color: '#fff',
                time: 100,
              },
            ],
          };
        else if (request.setEntityValue) {
          switchValue = (request.setEntityValue as { value: boolean }).value;
          response.success = {};
        } else response.success = {};
        send({ response });
      });
    });
    const config = {
      RUST_SERVER_IP: '127.0.0.1',
      RUST_APP_PORT: address.port,
      RUST_STEAM_ID: '76561198000000000',
      RUST_PLAYER_TOKEN: '-123',
      RUST_USE_PROXY: false,
    } as Config;
    const connection = new Connection(
      config,
      () => [
        { id: '42', name: 'Switch', type: 'switch', sensitive: false, enabled: true },
        { id: '43', name: 'Alarm', type: 'alarm', sensitive: false, enabled: true },
      ],
      undefined,
      0,
    );
    try {
      const ready = once(connection, 'ready');
      connection.start();
      await ready;
      expect(connection.info?.name).toBe('Local Protocol Test');
      expect(requests[0].playerId).toBe(config.RUST_STEAM_ID);
      expect(requests[0].playerToken).toBe(-123);
      expect(requests.filter((r) => r.getEntityInfo).map((r) => r.entityId)).toEqual([42, 43]);
      await expect(connection.setSwitch('42', true)).resolves.toBe(true);
      const alarm = once(connection, 'device');
      send({ broadcast: { entityChanged: { entityId: 43, payload: { value: true } } } });
      expect(await alarm).toEqual(['43', true, false]);
      const chat = once(connection, 'chat');
      send({
        broadcast: {
          teamMessage: {
            message: {
              steamId: '76561198000000001',
              name: 'Hakan',
              message: 'Hello!',
              color: '#fff',
              time: 101,
            },
          },
        },
      });
      const [message] = (await chat) as [TeamMessage];
      expect(message.name).toBe('Hakan');
      expect(message.steamId.toString()).toBe('76561198000000001');
      expect(message.message).toBe('Hello!');
      const history = await connection.request({ getTeamChat: {} });
      expect(history.teamChat?.messages[0].message).toBe('Got sulfur?');
      const sent = await connection.request({
        sendTeamMessage: { message: '[Discord] Alper: hi' },
      });
      expect(sent.success).toBeTruthy();
    } finally {
      connection.stop();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10000);
});
