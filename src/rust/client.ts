import { createRequire } from 'node:module';
import RustPlus from '@liamcottle/rustplus.js';
import type { Config } from '../config';
import { ProtocolDecodeFailure, type RustClient } from './protocol';

// Use the library's own protobuf runtime so reflection objects remain compatible.
const upstreamRequire = createRequire(require.resolve('@liamcottle/rustplus.js'));
const protobuf = upstreamRequire('protobufjs') as typeof import('protobufjs');

export function createRustClient(config: Config): RustClient {
  const client = new RustPlus(
    config.RUST_SERVER_IP,
    config.RUST_APP_PORT,
    config.RUST_STEAM_ID,
    config.RUST_PLAYER_TOKEN,
    config.RUST_USE_PROXY,
  );
  // Installed rustplus.js 2.5.0 assigns AppMessage before emitting connected.
  // Run before the manager's listener, which starts authenticated requests.
  client.on('connected', () => {
    try {
      const messageType = client.AppMessage;
      const root = messageType.root;
      // Optional camera pose fields from RustPlusApi's current companion contracts.
      // Keep upstream transport/requests intact; old servers may omit these entirely.
      const cameraRays = root.lookupType('rustplus.AppCameraRays');
      for (const [name, id] of [
        ['cameraPosition', 7],
        ['cameraRotation', 8],
        ['sampleRotation', 9],
      ] as const)
        if (!cameraRays.fields[name] && !cameraRays.fieldsById[id])
          cameraRays.add(new protobuf.Field(name, id, 'Vector3', 'optional'));
      // Rust omits default-valued metadata (upstream PR #77 / issues #76 and #81).
      // Apply defaults to the data our bot consumes, retaining identity/text fields,
      // response correlation, request requirements, entity types and payload presence.
      const metadataTypes: [string, string[]][] = [
        ['rustplus.AppInfo', ['name']],
        // No-team responses omit the zero leader ID. This is normal data, not a transport failure.
        ['rustplus.AppTeamInfo', []],
        ['rustplus.AppTeamInfo.Member', ['steamId', 'name']],
        ['rustplus.AppTeamInfo.Note', []],
        ['rustplus.AppTeamMessage', ['steamId', 'name', 'message']],
        ['rustplus.AppCameraInfo', ['width', 'height']],
        ['rustplus.AppCameraRays', ['rayData']],
        ['rustplus.AppCameraRays.Entity', []],
      ];
      for (const [typeName, required] of metadataTypes) {
        const type = root.lookupType(typeName);
        for (const field of [...type.fieldsArray]) {
          if (!field.required || required.includes(field.name)) continue;
          const replacement = protobuf.Field.fromJSON(field.name, {
            ...field.toJSON(),
            rule: 'optional',
          });
          type.remove(field).add(replacement);
        }
      }
      root.resolveAll();
      messageType.setup();
      const decode = messageType.decode;
      let failed = false;
      messageType.decode = (reader, length) => {
        if (failed) return messageType.create();
        try {
          return decode.call(messageType, reader, length);
        } catch (error) {
          // Upstream decodes inside an unguarded WebSocket callback. Its error event
          // lets the manager cancel pending requests and reconnect without a process crash.
          failed = true;
          // Log only schema metadata, never packet contents or raw upstream errors.
          let schemaField: string | undefined;
          if (error instanceof protobuf.util.ProtocolError) {
            const instance = error.instance as { $type?: import('protobufjs').Type } | undefined;
            const type = instance?.$type;
            const missing = /^missing required '([A-Za-z]\w*)'$/.exec(error.message);
            if (type instanceof protobuf.Type && missing && type.fields[missing[1]])
              schemaField = `${type.fullName.replace(/^\./, '')}.${missing[1]}`;
          }
          client.emit('error', new ProtocolDecodeFailure(schemaField));
          return messageType.create();
        }
      };
    } catch {
      client.emit('error', new ProtocolDecodeFailure());
    }
  });
  return client;
}
