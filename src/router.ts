import { Channel, NewMessage } from './types.js';
import { parseMarkdown, toPlainText } from './chat-sdk.js';
import { formatLocalTime } from './timezone.js';
import { resolveJid } from './jid-map.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

/**
 * Channel-aware outbound formatter.
 * Strips internal tags and normalizes markdown per channel capability.
 * @deprecated Use formatOutboundForAdapter instead.
 */
export function formatOutboundForChannel(
  rawText: string,
  channelName: string,
): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';

  if (channelName === 'whatsapp') {
    return toPlainText(parseMarkdown(text));
  }

  return text;
}

/**
 * Adapter-aware outbound formatter.
 * Strips internal tags. For Chat SDK adapters, passes through markdown
 * (adapter handles conversion via { markdown } in thread.post).
 * For native WhatsApp (Baileys), converts to plain text.
 */
export function formatOutboundForAdapter(
  rawText: string,
  jid: string,
): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';

  // Chat SDK adapters handle markdown conversion themselves
  const mapping = resolveJid(jid);
  if (mapping) return text;

  // Legacy WhatsApp channel: strip markdown to plain text
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')) {
    return toPlainText(parseMarkdown(text));
  }

  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
