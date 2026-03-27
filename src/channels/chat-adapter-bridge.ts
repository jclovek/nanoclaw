/**
 * Chat SDK Adapter Bridge
 *
 * Wraps all registered Chat SDK adapters as a single NanoClaw Channel.
 * Per-platform adapter files call registerChatAdapter() to register
 * their adapter factory. The bridge collects them, creates a single
 * Chat instance, and exposes NanoClaw's Channel interface.
 */
import { Chat } from 'chat';
import type { Adapter, Thread, Message as ChatMessage } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// --- Adapter registration ---

type AdapterFactory = () => Adapter | null;

const adapterFactories = new Map<string, AdapterFactory>();

/**
 * Register a Chat SDK adapter. Called from per-platform files
 * (e.g., src/channels/adapters/teams.ts).
 *
 * The factory should return null if required env vars are missing.
 */
export function registerChatAdapter(
  name: string,
  factory: AdapterFactory,
): void {
  adapterFactories.set(name, factory);
}

/** Get all registered adapter factory names. */
export function getRegisteredAdapterNames(): string[] {
  return [...adapterFactories.keys()];
}

/** Get an adapter factory by name. */
export function getChatAdapterFactory(
  name: string,
): AdapterFactory | undefined {
  return adapterFactories.get(name);
}

// --- JID ↔ threadId mapping ---

/**
 * Maps NanoClaw JIDs to Chat SDK thread IDs.
 * Built up as messages arrive; used for outbound routing.
 */
const jidToThreadId = new Map<string, string>();
const threadIdToJid = new Map<string, string>();

function jidFromThreadId(adapterName: string, threadId: string): string {
  // Chat SDK thread IDs are {adapter}:{channel}:{thread}
  // NanoClaw JIDs use {adapter}:{channel} (drop the thread part for group identity)
  // But we need to keep the full threadId for outbound routing
  const cached = threadIdToJid.get(threadId);
  if (cached) return cached;

  // Use full threadId as JID to preserve routing fidelity
  const jid = `csdk:${adapterName}:${threadId}`;
  threadIdToJid.set(threadId, jid);
  jidToThreadId.set(jid, threadId);
  return jid;
}

function threadIdFromJid(jid: string): string | undefined {
  return jidToThreadId.get(jid);
}

// --- Message conversion ---

function convertMessage(
  adapterName: string,
  threadId: string,
  message: ChatMessage,
): { jid: string; newMessage: NewMessage } {
  const jid = jidFromThreadId(adapterName, threadId);

  const newMessage: NewMessage = {
    id: message.id,
    chat_jid: jid,
    sender: message.author.userId,
    sender_name: message.author.fullName || message.author.userName,
    content: message.text,
    timestamp: message.metadata.dateSent.toISOString(),
    is_from_me: message.author.isMe,
    is_bot_message: message.author.isBot === true || message.author.isMe,
  };

  return { jid, newMessage };
}

// --- Channel implementation ---

class ChatSdkChannel implements Channel {
  name = 'chat-sdk';

  private chat: Chat | null = null;
  private adapters = new Map<string, Adapter>();
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;

  constructor(adapters: Map<string, Adapter>, opts: ChannelOpts) {
    this.adapters = adapters;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  async connect(): Promise<void> {
    const adapterMap: Record<string, Adapter> = {};
    for (const [name, adapter] of this.adapters) {
      adapterMap[name] = adapter;
    }

    const state = createMemoryState();

    this.chat = new Chat({
      userName: ASSISTANT_NAME,
      adapters: adapterMap,
      state,
      logger: 'silent',
      // Force-release locks so handlers never block on prior slow handlers.
      // NanoClaw manages its own concurrency via GroupQueue.
      onLockConflict: 'force',
    });

    // --- Register handlers ---
    // All handlers do the same thing: convert the message and forward
    // to NanoClaw's pipeline. Subscribe to the thread so follow-up
    // messages also come through.

    const forwardMessage = async (
      thread: Thread,
      message: ChatMessage,
      adapterName: string,
    ) => {
      const { jid, newMessage } = convertMessage(
        adapterName,
        thread.id,
        message,
      );

      // Notify NanoClaw of the chat metadata
      const chatName = thread.id; // Best we have without platform-specific logic
      this.onChatMetadata(
        jid,
        newMessage.timestamp,
        chatName,
        'chat-sdk',
        true,
      );

      // Forward the message
      this.onMessage(jid, newMessage);

      // Subscribe so follow-up messages also come through
      await thread.subscribe();
    };

    // New @-mentions in unsubscribed threads
    this.chat.onNewMention(async (thread, message) => {
      const adapterName = this.adapterNameForThread(thread.id);
      await forwardMessage(thread, message, adapterName);
    });

    // Direct messages
    this.chat.onDirectMessage(async (thread, message) => {
      const adapterName = this.adapterNameForThread(thread.id);
      await forwardMessage(thread, message, adapterName);
    });

    // Follow-up messages in subscribed threads
    this.chat.onSubscribedMessage(async (thread, message) => {
      const adapterName = this.adapterNameForThread(thread.id);
      const { jid, newMessage } = convertMessage(
        adapterName,
        thread.id,
        message,
      );
      this.onMessage(jid, newMessage);
    });

    // Catch-all for non-mention messages in unsubscribed threads
    this.chat.onNewMessage(/./, async (thread, message) => {
      const adapterName = this.adapterNameForThread(thread.id);
      await forwardMessage(thread, message, adapterName);
    });

    await this.chat.initialize();

    logger.info(
      { adapters: [...this.adapters.keys()] },
      'Chat SDK channel connected',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatThreadId = threadIdFromJid(jid);
    if (!chatThreadId) {
      logger.warn({ jid }, 'No threadId mapping for JID, cannot send');
      return;
    }

    // Find which adapter owns this thread
    const adapterName = this.adapterNameForThread(chatThreadId);
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      logger.warn({ jid, adapterName }, 'Adapter not found for thread');
      return;
    }

    // Send as { markdown } so each adapter converts to its platform's native
    // format (mrkdwn for Slack, HTML for Teams, WhatsApp formatting, etc.).
    // Plain strings bypass conversion entirely.
    await adapter.postMessage(chatThreadId, { markdown: text });
  }

  isConnected(): boolean {
    return this.chat !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('csdk:');
  }

  async disconnect(): Promise<void> {
    if (this.chat) {
      await this.chat.shutdown();
      this.chat = null;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;

    const chatThreadId = threadIdFromJid(jid);
    if (!chatThreadId) return;

    const adapterName = this.adapterNameForThread(chatThreadId);
    const adapter = this.adapters.get(adapterName);
    if (!adapter) return;

    try {
      await adapter.startTyping(chatThreadId);
    } catch {
      // Typing indicators are best-effort
    }
  }

  /**
   * Derive the adapter name from a Chat SDK thread ID.
   * Thread IDs follow the pattern {adapter}:{channel}:{thread}.
   */
  private adapterNameForThread(threadId: string): string {
    const colonIdx = threadId.indexOf(':');
    if (colonIdx === -1) return threadId;
    return threadId.slice(0, colonIdx);
  }
}

// --- Channel factory registration ---

registerChannel('chat-sdk', (opts: ChannelOpts): Channel | null => {
  const adapters = new Map<string, Adapter>();

  for (const [name, factory] of adapterFactories) {
    try {
      const adapter = factory();
      if (adapter) {
        adapters.set(name, adapter);
        logger.info({ adapter: name }, 'Chat SDK adapter registered');
      }
    } catch (err) {
      logger.warn({ adapter: name, err }, 'Failed to create Chat SDK adapter');
    }
  }

  if (adapters.size === 0) {
    logger.debug('No Chat SDK adapters configured, skipping channel');
    return null;
  }

  return new ChatSdkChannel(adapters, opts);
});
