import { ChannelType, SlashCommandBuilder } from 'discord.js';

const idOption = { name: 'id', description: 'Registered Rust+ entity ID', required: true };
export const commands = [
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
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(
        {
          status: 'Show Rust+ and bot status',
          help: 'Show commands and setup tips',
          ping: 'Show Discord latency and Rust+ availability',
        }[name]!,
      ),
  ),
].map((command) => command.setDMPermission(false).toJSON());
