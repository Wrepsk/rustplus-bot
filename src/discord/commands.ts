import { ApplicationCommandOptionType, ChannelType, SlashCommandBuilder } from 'discord.js';

const idOption = { name: 'id', description: 'Registered Rust+ entity ID', required: true };
export const commands = [
  new SlashCommandBuilder()
    .setName('camera')
    .setDescription('View registered Rust+ cameras and control movement')
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription(
          'Create or refresh this server’s camera panel in this channel (administrator)',
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Register a CCTV, PTZ, drone or turret camera (administrator)')
        .addStringOption((o) =>
          o
            .setName('id')
            .setDescription('In-game camera identifier (not an entity ID)')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(32),
        )
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Friendly camera name')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(60),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a registered camera (administrator)')
        .addStringOption((o) =>
          o
            .setName('id')
            .setDescription('Registered camera identifier')
            .setRequired(true)
            .setMaxLength(32),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show cameras and choose one to view'))
    .addSubcommand((s) =>
      s
        .setName('watch')
        .setDescription('Open a private web viewer with manual movement controls')
        .addStringOption((o) =>
          o
            .setName('id')
            .setDescription('Optional registered identifier; omit to choose a camera')
            .setMaxLength(32),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('share')
        .setDescription('Allow operators to borrow YOUR offline account for cameras on this server')
        .addBooleanOption((o) =>
          o
            .setName('enabled')
            .setDescription('Explicitly enable sharing, or revoke it immediately')
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('stop')
        .setDescription('Close your camera session; administrators may stop any viewer'),
    ),
  new SlashCommandBuilder()
    .setName('server')
    .setDescription('Manage saved Rust servers')
    .addSubcommand((s) =>
      s.setName('list').setDescription('List all servers and their connection states'),
    )
    .addSubcommand((s) =>
      s
        .setName('use')
        .setDescription('Select the server for your commands')
        .addStringOption((o) =>
          o.setName('id').setDescription('Optional server ID; omit to choose from a menu'),
        ),
    )
    .addSubcommand((s) =>
      s.setName('pause').setDescription('Pause monitoring and chat for this server'),
    )
    .addSubcommand((s) =>
      s.setName('resume').setDescription('Resume monitoring and chat for this server'),
    )
    .addSubcommand((s) =>
      s
        .setName('rename')
        .setDescription('Rename a saved Rust server (administrator)')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('New friendly server name')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(80),
        ),
    ),
  new SlashCommandBuilder()
    .setName('pair')
    .setDescription('Pair Rust+ accounts, servers and devices')
    .addSubcommand((s) =>
      s.setName('start').setDescription('Get the one-time local helper command'),
    )
    .addSubcommand((s) =>
      s
        .setName('import')
        .setDescription('Import encrypted credentials from the local helper')
        .addStringOption((o) =>
          o
            .setName('data')
            .setDescription('Encrypted output from the helper')
            .setRequired(true)
            .setMaxLength(4000),
        ),
    )
    .addSubcommand((s) =>
      s.setName('inbox').setDescription('Show your recent in-game server and device pairings'),
    )
    .addSubcommand((s) =>
      s
        .setName('accept')
        .setDescription('Save a server/device or link your personal chat account')
        .addStringOption((o) =>
          o
            .setName('id')
            .setDescription('Pairing ID from /pair inbox')
            .setRequired(true)
            .setMaxLength(12),
        )
        .addStringOption((o) =>
          o.setName('name').setDescription('Friendly server/device name').setMaxLength(60),
        )
        .addBooleanOption((o) =>
          o.setName('sensitive').setDescription('Require confirmation before changing this switch'),
        ),
    )
    .addSubcommand((s) =>
      s.setName('status').setDescription('Show your pairing and personal chat status'),
    )
    .addSubcommand((s) =>
      s
        .setName('unlink')
        .setDescription('Remove your pairing listener and personal chat identities'),
    ),
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Create or refresh the base control panel'),
  new SlashCommandBuilder()
    .setName('device')
    .setDescription('Manage paired smart devices')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Register a paired device')
        .addStringOption((o) =>
          o
            .setName('id')
            .setDescription('Rust+ entity ID from pairing')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(10),
        )
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Friendly device name')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(60),
        )
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('Device type')
            .setRequired(true)
            .addChoices(
              { name: 'Smart Switch', value: 'switch' },
              { name: 'Smart Alarm', value: 'alarm' },
            ),
        )
        .addBooleanOption((o) =>
          o.setName('sensitive').setDescription('Require confirmation before changing this switch'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a registered device')
        .addStringOption((o) =>
          o.setName(idOption.name).setDescription(idOption.description).setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('rename')
        .setDescription('Rename a device')
        .addStringOption((o) =>
          o.setName('id').setDescription(idOption.description).setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('name').setDescription('New name').setRequired(true).setMaxLength(60),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('List registered devices')
        .addIntegerOption((o) =>
          o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(10),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('status')
        .setDescription('Query the actual device state')
        .addStringOption((o) =>
          o.setName('id').setDescription(idOption.description).setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName('alarm')
    .setDescription('Manage Smart Alarm notifications')
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('List alarms and their notification state')
        .addIntegerOption((o) =>
          o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(10),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('enable')
        .setDescription('Enable notifications for an alarm')
        .addStringOption((o) =>
          o.setName('id').setDescription(idOption.description).setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('disable')
        .setDescription('Disable notifications for an alarm')
        .addStringOption((o) =>
          o.setName('id').setDescription(idOption.description).setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('test')
        .setDescription('Send a simulated alert; no Rust device is triggered')
        .addStringOption((o) =>
          o.setName('id').setDescription(idOption.description).setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Configure two-way team chat')
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Set the dedicated Discord team-chat channel')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Team-chat channel')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) => s.setName('enable').setDescription('Enable the team-chat bridge'))
    .addSubcommand((s) => s.setName('disable').setDescription('Disable the team-chat bridge'))
    .addSubcommand((s) => s.setName('status').setDescription('Show team-chat bridge status')),
  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure bot access and alerts')
    .addSubcommand((s) =>
      s
        .setName('role-add')
        .setDescription('Allow a role to operate switches and relay chat')
        .addRoleOption((o) => o.setName('role').setDescription('Allowed role').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('role-remove')
        .setDescription('Remove a role from the allow list')
        .addRoleOption((o) => o.setName('role').setDescription('Role to remove').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('roles').setDescription('List allowed operator roles'))
    .addSubcommand((s) =>
      s
        .setName('alerts')
        .setDescription('Configure alarm alerts')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Alert channel')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((o) =>
          o.setName('role').setDescription('Optional role to mention; omit to clear'),
        ),
    ),
  ...['status', 'help', 'ping'].map((name) =>
    new SlashCommandBuilder().setName(name).setDescription(
      {
        status: 'Show Rust+ and bot status',
        help: 'Show commands and setup tips',
        ping: 'Show Discord latency and Rust+ availability',
      }[name]!,
    ),
  ),
].map((command) => {
  const json = command.setDMPermission(false).toJSON();
  const option = {
    type: ApplicationCommandOptionType.String as const,
    name: 'server',
    description: 'Optional server ID; omit to choose from a server menu',
    required: false,
    max_length: 32,
  };
  if (json.options?.some((o) => o.type === ApplicationCommandOptionType.Subcommand)) {
    for (const sub of json.options)
      if (sub.type === ApplicationCommandOptionType.Subcommand)
        sub.options = [...(sub.options || []), option];
  } else json.options = [...(json.options || []), option];
  return json;
});
