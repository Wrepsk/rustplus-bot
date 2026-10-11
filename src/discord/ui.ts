import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { PairingService } from '../pairing/service';
import type { Pairing } from '../pairing/schema';
import type { Servers, ServerProfile } from '../servers';

export function card(title: string, description?: string, server?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xce6f3e)
    .setTitle(title)
    .setFooter({ text: 'Rust Base • Rust+ companion' })
    .setTimestamp();
  if (description) embed.setDescription(description.slice(0, 4096));
  if (server) embed.setAuthor({ name: server.slice(0, 256) });
  return embed;
}
export const button = (
  id: string,
  label: string,
  style = ButtonStyle.Secondary,
  disabled = false,
) =>
  new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setDisabled(disabled);

export function commandServerPicker(token: string, profiles: ServerProfile[], command: string) {
  return {
    embeds: [
      card(
        '🖥 Choose a Rust server',
        `Choose which server should run **${command}**.\nYour other command options are saved. Nothing runs until you select a server.\n\nThis private selection expires in **5 minutes**.`,
      ),
    ],
    allowedMentions: { parse: [] as [] },
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`command-server:${token}`)
          .setPlaceholder('Select a Rust server…')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            profiles.map((profile) => ({
              label: profile.name.slice(0, 100),
              value: profile.id,
              description:
                `${profile.enabled ? 'Monitoring enabled' : 'Paused'} • ${profile.ip}:${profile.port}`.slice(
                  0,
                  100,
                ),
            })),
          ),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`command-cancel:${token}`, 'Cancel'),
      ),
    ],
  };
}

export function inboxView(service: PairingService, user: string, requested = 0, notice = '') {
  const entries = service.inbox(user).reverse();
  const pages = Math.max(1, Math.ceil(entries.length / 4));
  const page = Math.max(0, Math.min(pages - 1, requested));
  const embed = card(
    '📥 Your pairing inbox',
    (notice ? `${notice}\n\n` : '') +
      (entries.length
        ? 'Accept a pairing to choose its name. Decline clears this inbox entry.'
        : 'No pairings yet. Pair a server or Smart Device in Rust, then press Refresh.') +
      '\nDevices and new monitoring servers require administrator access. Entries expire after 24 hours.',
  );
  embed.setFooter({
    text: `${entries.length} incoming • Page ${page + 1}/${pages} • Private to you`,
  });
  const components = entries.slice(page * 4, (page + 1) * 4).map(({ id, pairing }, index) => {
    const name =
      pairing.type === 'server'
        ? pairing.name
        : pairing.entityName || (pairing.entityType === 1 ? 'Smart Switch' : 'Smart Alarm');
    embed.addFields({
      name: `${index + 1}. ${name.slice(0, 240)}`,
      value:
        pairing.type === 'server'
          ? `🖥 Server • \`${pairing.ip}:${pairing.port}\``
          : `${pairing.entityType === 1 ? '🔌 Smart Switch' : '🚨 Smart Alarm'} • Entity \`${pairing.entityId}\`\nServer: \`${pairing.ip}:${pairing.port}\``,
    });
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(`pairui:accept:${user}:${id}:${page}`, `Accept ${index + 1}`, ButtonStyle.Success),
      button(`pairui:decline:${user}:${id}:${page}`, `Decline ${index + 1}`),
    );
  });
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(
        `pairui:inbox:${user}:none:${page - 1}`,
        'Previous',
        ButtonStyle.Secondary,
        page === 0,
      ),
      button(`pairui:inbox:${user}:none:${page}`, 'Refresh', ButtonStyle.Primary),
      button(
        `pairui:inbox:${user}:none:${page + 1}`,
        'Next',
        ButtonStyle.Secondary,
        page === pages - 1,
      ),
    ),
  );
  return { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
}

export function pairingModal(
  user: string,
  id: string,
  page: number,
  pairing: Pairing,
): ModalBuilder {
  const name = (
    pairing.type === 'server'
      ? pairing.name
      : pairing.entityName || (pairing.entityType === 1 ? 'Smart Switch' : 'Smart Alarm')
  ).slice(0, 60);
  const modal = new ModalBuilder()
    .setCustomId(`pairui:save:${user}:${id}:${page}`)
    .setTitle('Accept pairing');
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Friendly name')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(60)
        .setValue(name)
        .setRequired(true),
    ),
  );
  if (pairing.type === 'entity' && pairing.entityType === 1)
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('sensitive')
          .setLabel('Destructive equipment? Enter yes or no')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(3)
          .setValue('no')
          .setRequired(true),
      ),
    );
  return modal;
}

export function serversView(servers: Servers, user: string, state: (id: string) => string) {
  const selected = servers.selected(user);
  const embed = card(
    '🖥 Rust servers',
    'Choose your default server below. Each server keeps its own controls, alarms and chat channel. Pair another server through `/pair start`.',
  );
  for (const profile of servers.list()) {
    const store = servers.store(profile.id),
      chat = store.get('chatChannel', '');
    embed.addFields({
      name: `${profile.id === selected ? '▸ ' : ''}${profile.name.slice(0, 240)}`,
      value: `**${state(profile.id)}** • ${store.devices().length} devices • \`${profile.id}\`\nChat: ${chat ? `<#${chat}>` : 'Not configured'}`,
    });
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`servers:select:${user}`)
    .setPlaceholder('Choose your default Rust server')
    .addOptions(
      servers.list().map((p) => ({
        label: p.name.slice(0, 100),
        value: p.id,
        default: p.id === selected,
        description: `${state(p.id)} • ${p.id}`.slice(0, 100),
      })),
    );
  return {
    embeds: [embed],
    allowedMentions: { parse: [] as [] },
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`servers:refresh:${user}`, 'Refresh', ButtonStyle.Primary),
        button(
          `servers:${servers.get(selected).enabled ? 'pause' : 'resume'}:${user}:${selected}`,
          servers.get(selected).enabled ? 'Pause selected server' : 'Resume selected server',
        ),
      ),
    ],
  };
}

export function pairingStatus(service: PairingService, servers: Servers, id: string, user: string) {
  const identity = servers.identity(id, user);
  return {
    embeds: [
      card('🔗 Your Rust+ account', undefined, servers.get(id).name).addFields(
        { name: 'Pairing listener', value: service.status(user), inline: true },
        {
          name: 'Personal chat identity',
          value: identity ? `Steam \`${identity.playerId}\`` : 'Not linked — use `/pair start`',
          inline: true,
        },
        {
          name: 'Next step',
          value:
            'Pair in-game, then check your inbox. Your Steam account must belong to the mirrored Rust team to send chat.',
        },
      ),
    ],
    allowedMentions: { parse: [] as [] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`pairui:inbox:${user}:none:0`, 'Open pairing inbox', ButtonStyle.Primary),
        button(`pairui:unlink:${user}:none:0`, 'Unlink my account', ButtonStyle.Danger),
      ),
    ],
  };
}
