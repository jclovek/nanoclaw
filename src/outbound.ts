/**
 * Unified outbound messaging.
 * Routes messages to Chat SDK adapters (via ThreadImpl) or legacy channels.
 */
import { ThreadImpl } from 'chat';

import { logger } from './logger.js';
import { resolveJid } from './jid-map.js';
import { findChannel } from './router.js';
import type { Channel } from './types.js';

/** Legacy channels array, set once at startup via setLegacyChannels(). */
let legacyChannels: Channel[] = [];

/** Register legacy channels for fallback routing. Called once from index.ts. */
export function setLegacyChannels(channels: Channel[]): void {
  legacyChannels = channels;
}

/**
 * Send a message to a JID.
 * Tries Chat SDK adapter first (via JID map), falls back to legacy channel.
 */
export async function send(jid: string, text: string): Promise<void> {
  const mapping = resolveJid(jid);

  if (mapping) {
    try {
      const channelId = deriveChannelId(mapping.threadId);
      const thread = new ThreadImpl({
        id: mapping.threadId,
        channelId,
        adapterName: mapping.adapterName,
      });
      await thread.post({ markdown: text });
      return;
    } catch (err) {
      logger.warn(
        { jid, adapter: mapping.adapterName, err },
        'Chat SDK send failed, trying legacy fallback',
      );
    }
  }

  // Legacy fallback
  const channel = findChannel(legacyChannels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel or adapter found for JID');
    return;
  }
  await channel.sendMessage(jid, text);
}

/** Send typing indicator to a JID. Best-effort, never throws. */
export async function sendTyping(jid: string): Promise<void> {
  const mapping = resolveJid(jid);

  if (mapping) {
    try {
      const channelId = deriveChannelId(mapping.threadId);
      const thread = new ThreadImpl({
        id: mapping.threadId,
        channelId,
        adapterName: mapping.adapterName,
      });
      await thread.startTyping();
      return;
    } catch {
      // Typing is best-effort
    }
  }

  // Legacy fallback
  const channel = findChannel(legacyChannels, jid);
  await channel?.setTyping?.(jid, true);
}

/**
 * Derive channelId from a Chat SDK threadId.
 * Thread IDs are typically `adapter:channel:thread`.
 * Channel ID is `adapter:channel`.
 */
function deriveChannelId(threadId: string): string {
  const parts = threadId.split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return threadId;
}
