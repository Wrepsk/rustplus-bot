import type { Client } from 'discord.js';
import type { Store } from '../database';

interface Reference {
  channelId: string;
  messageId: string;
}

// Retain moved panels too, so removing a server can delete its retired messages.
export function rememberPanel(store: Store, reference: Reference): void {
  const saved = store.get<Reference[]>('serverPanelMessages', []);
  if (
    !saved.some((r) => r.channelId === reference.channelId && r.messageId === reference.messageId)
  )
    store.set('serverPanelMessages', [...saved, reference]);
}

export async function deleteServerPanels(client: Client, store: Store): Promise<void> {
  for (const key of ['panel', 'cameraPanel']) {
    const current = store.get<Reference | null>(key, null);
    if (current) rememberPanel(store, current); // Compatible with existing databases.
  }
  for (const ref of store.get<Reference[]>('serverPanelMessages', [])) {
    try {
      const channel = await client.channels.fetch(ref.channelId);
      if (channel) {
        if (!channel.isTextBased()) throw new Error('Panel channel is not accessible.');
        await (await channel.messages.fetch(ref.messageId)).delete();
      }
    } catch (error) {
      // Deleted messages/channels already satisfy cleanup. Permissions/network errors do not.
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        [10003, 10008].includes(Number(error.code))
      ))
        throw error;
    }
    store.set(
      'serverPanelMessages',
      store
        .get<Reference[]>('serverPanelMessages', [])
        .filter((r) => r.channelId !== ref.channelId || r.messageId !== ref.messageId),
    );
    for (const key of ['panel', 'cameraPanel']) {
      const current = store.get<Reference | null>(key, null);
      if (current?.channelId === ref.channelId && current.messageId === ref.messageId)
        store.set(key, null);
    }
  }
  store.set('panel', null);
  store.set('cameraPanel', null);
}
