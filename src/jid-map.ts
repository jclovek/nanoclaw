/**
 * JID-to-adapter mapping.
 * Maps NanoClaw JIDs to Chat SDK adapter names + thread IDs.
 * Populated when inbound messages arrive; consulted on outbound.
 */
import { getDatabase } from './db.js';
import { RegisteredGroup } from './types.js';

export interface JidMapping {
  adapterName: string;
  threadId: string;
}

/** Record a JID → adapter+threadId mapping. Called when inbound messages arrive. */
export function recordJidMapping(
  jid: string,
  adapterName: string,
  threadId: string,
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR REPLACE INTO jid_adapter_map (jid, adapter_name, thread_id, updated_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(jid, adapterName, threadId);
}

/** Resolve a JID to its Chat SDK adapter + threadId. Returns null for legacy-only channels. */
export function resolveJid(jid: string): JidMapping | null {
  const db = getDatabase();

  // Check DB first
  const row = db
    .prepare('SELECT adapter_name, thread_id FROM jid_adapter_map WHERE jid = ?')
    .get(jid) as { adapter_name: string; thread_id: string } | undefined;
  if (row) return { adapterName: row.adapter_name, threadId: row.thread_id };

  // Heuristic fallback for JIDs that predate the map.
  // These return null — they're handled by legacy channels.
  // When a Chat SDK adapter replaces a native channel, the map will be populated
  // via backfillFromRegisteredGroups or on first message.
  return null;
}

/**
 * At startup, populate the JID map for any registered groups that already have
 * known adapter mappings. This enables outbound for existing groups before
 * new inbound messages arrive.
 */
export function backfillFromRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO jid_adapter_map (jid, adapter_name, thread_id, updated_at)
     VALUES (?, ?, ?, datetime('now'))`,
  );

  for (const [jid] of Object.entries(groups)) {
    // Only backfill if we can derive the adapter from the JID prefix
    const mapping = inferAdapterFromJid(jid);
    if (mapping) {
      stmt.run(jid, mapping.adapterName, mapping.threadId);
    }
  }
}

/**
 * Infer adapter name and threadId from JID format.
 * Used for backfill and as a fallback.
 * Returns null for JIDs that can't be mapped to a Chat SDK adapter.
 */
function inferAdapterFromJid(jid: string): JidMapping | null {
  // csdk: prefix — already a Chat SDK JID from the bridge era
  if (jid.startsWith('csdk:')) {
    const rest = jid.slice(5); // remove 'csdk:'
    const colonIdx = rest.indexOf(':');
    if (colonIdx !== -1) {
      return {
        adapterName: rest.slice(0, colonIdx),
        threadId: rest.slice(colonIdx + 1),
      };
    }
  }

  // Native JID formats are handled by legacy channels, not Chat SDK
  // These will be mapped when those channels migrate to Chat SDK adapters
  return null;
}
