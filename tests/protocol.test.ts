import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { Client, Message } from 'discord.js';
import { ChatBridge } from '../src/chat';
import { Store } from '../src/database';
import { Permissions } from '../src/permissions';
import type { Config } from '../src/config';
import { Connection } from '../src/rust/connection';
import type { TeamMessage } from '../src/domain';

const libraryPath = require.resolve('@liamcottle/rustplus.js');
const upstreamRequire = createRequire(libraryPath);
const protobuf = upstreamRequire('protobufjs') as typeof import('protobufjs');

describe('installed rustplus.js protocol compatibility', () => {
  it.each([false, true])(
    'authenticates, controls switches and restores subscriptions (omitted defaults: %s)',
    async (omitDefaults) => {
      const root = await protobuf.load(join(dirname(libraryPath), 'rustplus.proto'));
      const originalType = protobuf.Root.fromJSON(root.toJSON()).lookupType('rustplus.AppMessage');
      // Independently simulate default values absent from server wire frames.
      if (omitDefaults) {
        for (const [name, fieldName] of [
          ['rustplus.AppInfo', 'queuedPlayers'],
          ['rustplus.AppTeamInfo.Member', 'isOnline'],
          ['rustplus.AppTeamInfo.Member', 'x'],
          ['rustplus.AppTeamInfo.Member', 'y'],
          ['rustplus.AppTeamInfo.Member', 'spawnTime'],
          ['rustplus.AppTeamInfo.Member', 'isAlive'],
          ['rustplus.AppTeamInfo.Member', 'deathTime'],
          ['rustplus.AppTeamInfo.Note', 'type'],
          ['rustplus.AppTeamInfo.Note', 'x'],
          ['rustplus.AppTeamInfo.Note', 'y'],
          ['rustplus.AppTeamMessage', 'color'],
          ['rustplus.AppTeamMessage', 'time'],
        ]) {
          const type = root.lookupType(name),
            field = type.fields[fieldName];
          type
            .remove(field)
            .add(protobuf.Field.fromJSON(field.name, { ...field.toJSON(), rule: 'optional' }));
        }
      }
      const requestType = root.lookupType('rustplus.AppRequest'),
        messageType = root.lookupType('rustplus.AppMessage');
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await once(server, 'listening');
      const address = server.address();
      if (typeof address === 'string' || !address) throw new Error('No mock server address');
      const requests: Record<string, unknown>[] = [];
      let peer: WebSocket | undefined;
      let switchValue = false;
      let initialFrame: Uint8Array | undefined;
      const offlineMember = {
        steamId: '76561198000000002',
        name: 'Egemen',
        ...(omitDefaults
          ? {}
          : { x: 0, y: 0, isOnline: false, spawnTime: 0, isAlive: false, deathTime: 0 }),
      };
      const teamInfo = {
        leaderSteamId: '76561198000000001',
        members: [
          {
            steamId: '76561198000000001',
            name: 'Hakan',
            x: 10,
            y: 20,
            isOnline: true,
            spawnTime: 50,
            isAlive: true,
            deathTime: 0,
          },
          offlineMember,
        ],
        mapNotes: [{ x: 10, y: 20, ...(omitDefaults ? {} : { type: 0 }) }],
        leaderMapNotes: [omitDefaults ? {} : { type: 0, x: 0, y: 0 }],
      };
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
              ...(omitDefaults ? {} : { queuedPlayers: 0 }),
            };
          else if (request.getTeamInfo) response.teamInfo = teamInfo;
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
                  ...(omitDefaults ? {} : { color: '' }),
                  time: 100,
                },
              ],
            };
          else if (request.setEntityValue) {
            switchValue = (request.setEntityValue as { value: boolean }).value;
            response.success = {};
          } else {
            response.success = {};
            if (request.sendTeamMessage)
              send({
                broadcast: {
                  teamMessage: {
                    message: {
                      steamId: '76561198000000000',
                      name: 'ConnectedPlayer',
                      message: (request.sendTeamMessage as { message: string }).message,
                      ...(omitDefaults ? {} : { color: '', time: 0 }),
                    },
                  },
                },
              });
          }
          if (request.getInfo && !initialFrame)
            initialFrame = messageType.encode(messageType.fromObject({ response })).finish();
          send({ response });
        });
      });
      const config = {
        RUST_SERVER_IP: '127.0.0.1',
        RUST_APP_PORT: address.port,
        RUST_STEAM_ID: '76561198000000000',
        RUST_PLAYER_TOKEN: '-123',
        RUST_USE_PROXY: false,
        DISCORD_GUILD_ID: 'guild',
        CHAT_POLL_SECONDS: 0.05,
        RUST_CHAT_MAX_LENGTH: 128,
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
      const store = new Store(':memory:');
      store.set('chatChannel', 'channel');
      const discordSend = vi.fn(async () => ({}));
      const bridge = new ChatBridge(
        {
          channels: { fetch: async () => ({ isTextBased: () => true, send: discordSend }) },
        } as unknown as Client,
        connection,
        store,
        config,
        new Permissions('guild', 'owner', () => ['operator']),
      );
      try {
        const ready = once(connection, 'ready');
        connection.start();
        await ready;
        // The old decoder actually fails on this fixture; this is not a same-schema round trip.
        if (omitDefaults)
          expect(() => originalType.decode(initialFrame!)).toThrow(
            "missing required 'queuedPlayers'",
          );
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
        const team = await connection.request({ getTeamInfo: {} });
        expect(team.teamInfo?.members[1]).toMatchObject({
          steamId: expect.anything(),
          name: 'Egemen',
          isOnline: false,
          x: 0,
          y: 0,
          spawnTime: 0,
          isAlive: false,
          deathTime: 0,
        });
        expect(team.teamInfo?.members[0]).toMatchObject({ isOnline: true, x: 10, isAlive: true });
        if (omitDefaults) {
          // Reproduce the exact VPS failure with earlier required fields present.
          const frame = messageType
            .encode(
              messageType.fromObject({
                response: {
                  seq: 100,
                  teamInfo: {
                    leaderSteamId: teamInfo.leaderSteamId,
                    members: [
                      { ...offlineMember, x: 0, y: 0, spawnTime: 0, isAlive: false, deathTime: 0 },
                    ],
                  },
                },
              }),
            )
            .finish();
          expect(() => originalType.decode(frame)).toThrow("missing required 'isOnline'");
        }
        if (omitDefaults)
          expect(() =>
            originalType.decode(
              messageType
                .encode(
                  messageType.fromObject({
                    response: {
                      seq: 100,
                      teamInfo: {
                        leaderSteamId: '76561198000000001',
                        members: [],
                        mapNotes: [{ x: 10, y: 20 }],
                      },
                    },
                  }),
                )
                .finish(),
            ),
          ).toThrow("missing required 'type'");
        expect(
          (team.teamInfo as unknown as { mapNotes: { type: number }[] }).mapNotes[0].type,
        ).toBe(0);
        store.set('chatEnabled', true);
        await bridge.reset();
        expect(bridge.status()).toContain('Live');
        expect(discordSend).not.toHaveBeenCalled();
        const teamUpdate = once(connection, 'teamChanged');
        send({ broadcast: { teamChanged: { teamInfo } } });
        const [updatedTeam] = await teamUpdate;
        expect(updatedTeam.members[1].isOnline).toBe(false);
        expect(bridge.status()).toContain('Live');
        expect(connection.state).toBe('connected');
        const live = {
          steamId: '76561198000000001',
          name: 'Hakan',
          message: 'Anyone got sulfur?',
          time: 102,
          ...(omitDefaults ? {} : { color: '' }),
        };
        const incoming = once(connection, 'chat');
        send({ broadcast: { teamMessage: { message: live } } });
        await incoming;
        await bridge.drain();
        expect(discordSend).toHaveBeenCalledOnce();
        const reply = vi.fn();
        await bridge.fromDiscord({
          id: 'discord-1',
          content: 'Hello Rust',
          channelId: 'channel',
          guildId: 'guild',
          author: { id: 'owner', bot: false },
          webhookId: null,
          guild: {
            members: {
              fetch: async () => ({
                id: 'owner',
                displayName: 'Alper',
                permissions: { has: () => false },
                roles: { cache: new Map() },
              }),
            },
          },
          reply,
        } as unknown as Message);
        await bridge.drain();
        expect(reply).not.toHaveBeenCalled();
        expect(requests).toContainEqual(
          expect.objectContaining({
            sendTeamMessage: { message: '[Discord] Alper: Hello Rust' },
          }),
        );
        expect(discordSend).toHaveBeenCalledOnce(); // Own Rust echo was suppressed.
        const polled = requests.filter((r) => r.getTeamInfo).length;
        await vi.waitFor(() =>
          expect(requests.filter((r) => r.getTeamInfo).length).toBeGreaterThan(polled),
        );
        expect(connection.state).toBe('connected');
        const restored = once(connection, 'ready');
        peer!.terminate();
        await restored;
        expect(
          requests
            .filter((r) => r.getEntityInfo)
            .map((r) => r.entityId)
            .slice(-2),
        ).toEqual([42, 43]);
        expect(requests.filter((r) => r.getInfo)).toHaveLength(2);
        expect(connection.state).toBe('connected');
        await vi.waitFor(() => expect(bridge.status()).toContain('Live'));
        const duplicate = once(connection, 'chat');
        send({ broadcast: { teamMessage: { message: live } } });
        await duplicate;
        await bridge.drain();
        expect(discordSend).toHaveBeenCalledOnce();
      } finally {
        bridge.stop();
        connection.stop();
        await bridge.drain();
        store.close();
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    10000,
  );

  it.each(['initialization', 'later request'])(
    'recovers from a malformed frame during %s without an uncaught exception',
    async (stage) => {
      const root = await protobuf.load(join(dirname(libraryPath), 'rustplus.proto'));
      const requestType = root.lookupType('rustplus.AppRequest'),
        messageType = root.lookupType('rustplus.AppMessage');
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await once(server, 'listening');
      const address = server.address();
      if (typeof address === 'string' || !address) throw new Error('No mock server address');
      server.on('connection', (socket) => {
        socket.on('message', (bytes) => {
          const request = requestType.decode(Buffer.from(bytes as Buffer)) as unknown as {
            seq: number;
            getInfo?: object;
          };
          if (stage === 'initialization' || !request.getInfo) {
            // AppResponse with its required seq missing; the original library throws ProtocolError.
            socket.send(Buffer.from([0x0a, 0]));
            return;
          }
          socket.send(
            messageType
              .encode(
                messageType.fromObject({
                  response: {
                    seq: request.seq,
                    info: {
                      name: 'Mock',
                      headerImage: '',
                      url: '',
                      map: 'Procedural Map',
                      mapSize: 4000,
                      wipeTime: 0,
                      players: 1,
                      maxPlayers: 100,
                      queuedPlayers: 0,
                    },
                  },
                }),
              )
              .finish(),
          );
        });
      });
      const connection = new Connection(
        {
          RUST_SERVER_IP: '127.0.0.1',
          RUST_APP_PORT: address.port,
          RUST_STEAM_ID: '76561198000000000',
          RUST_PLAYER_TOKEN: '1',
          RUST_USE_PROXY: false,
        } as Config,
        () => [],
        undefined,
        0,
      );
      try {
        const reconnecting = new Promise<void>((resolve) =>
          connection.on('status', (state) => {
            if (state === 'reconnecting') resolve();
          }),
        );
        if (stage === 'later request') {
          const ready = once(connection, 'ready');
          connection.start();
          await ready;
          await expect(connection.request({ getTeamChat: {} })).rejects.toThrow('disconnected');
        } else connection.start();
        await reconnecting;
        expect(connection.state).toBe('reconnecting');
        expect(connection.online).toBe(false);
      } finally {
        connection.stop();
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    10000,
  );
});
