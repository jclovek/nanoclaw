/**
 * Chat SDK StateAdapter backed by NanoClaw's SQLite database.
 * Uses the shared better-sqlite3 instance from db.ts.
 */
import crypto from 'crypto';

import type Database from 'better-sqlite3';
import type { StateAdapter } from 'chat';

import { getDatabase } from './db.js';

interface Lock {
  threadId: string;
  token: string;
  expiresAt: number;
}

export class SqliteStateAdapter implements StateAdapter {
  private db!: Database.Database;

  async connect(): Promise<void> {
    this.db = getDatabase();
    // Clean up expired locks/keys on connect
    this.cleanup();
  }

  async disconnect(): Promise<void> {
    // Nothing to do — db lifecycle is managed by db.ts
  }

  // --- Key-value ---

  async get<T = unknown>(key: string): Promise<T | null> {
    this.cleanup();
    const row = this.db
      .prepare('SELECT value, expires_at FROM chat_sdk_kv WHERE key = ?')
      .get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM chat_sdk_kv WHERE key = ?').run(key);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    ttlMs?: number,
  ): Promise<void> {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    this.db
      .prepare(
        'INSERT OR REPLACE INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, ?)',
      )
      .run(key, JSON.stringify(value), expiresAt);
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number,
  ): Promise<boolean> {
    // Check and delete if expired first
    const existing = this.db
      .prepare('SELECT expires_at FROM chat_sdk_kv WHERE key = ?')
      .get(key) as { expires_at: number | null } | undefined;
    if (existing?.expires_at && existing.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM chat_sdk_kv WHERE key = ?').run(key);
    }

    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, ?)',
      )
      .run(key, JSON.stringify(value), expiresAt);
    return result.changes > 0;
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM chat_sdk_kv WHERE key = ?').run(key);
  }

  // --- Subscriptions ---

  async subscribe(threadId: string): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO chat_sdk_subscriptions (thread_id) VALUES (?)',
      )
      .run(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.db
      .prepare('DELETE FROM chat_sdk_subscriptions WHERE thread_id = ?')
      .run(threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const row = this.db
      .prepare(
        'SELECT 1 FROM chat_sdk_subscriptions WHERE thread_id = ? LIMIT 1',
      )
      .get(threadId);
    return !!row;
  }

  // --- Locks ---

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const now = Date.now();
    const token = crypto.randomUUID();
    const expiresAt = now + ttlMs;

    // Delete expired lock first
    this.db
      .prepare('DELETE FROM chat_sdk_locks WHERE thread_id = ? AND expires_at < ?')
      .run(threadId, now);

    // Try to insert (fails if lock exists and isn't expired)
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO chat_sdk_locks (thread_id, token, expires_at) VALUES (?, ?, ?)',
      )
      .run(threadId, token, expiresAt);

    if (result.changes === 0) return null;
    return { threadId, token, expiresAt };
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM chat_sdk_locks WHERE thread_id = ? AND token = ?',
      )
      .run(lock.threadId, lock.token);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const newExpiry = Date.now() + ttlMs;
    const result = this.db
      .prepare(
        'UPDATE chat_sdk_locks SET expires_at = ? WHERE thread_id = ? AND token = ?',
      )
      .run(newExpiry, lock.threadId, lock.token);
    if (result.changes > 0) {
      lock.expiresAt = newExpiry;
      return true;
    }
    return false;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.db
      .prepare('DELETE FROM chat_sdk_locks WHERE thread_id = ?')
      .run(threadId);
  }

  // --- Lists ---

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    const expiresAt = options?.ttlMs ? Date.now() + options.ttlMs : null;

    // Get next index
    const maxRow = this.db
      .prepare('SELECT MAX(idx) as maxIdx FROM chat_sdk_lists WHERE key = ?')
      .get(key) as { maxIdx: number | null } | undefined;
    const nextIdx = (maxRow?.maxIdx ?? -1) + 1;

    this.db
      .prepare(
        'INSERT INTO chat_sdk_lists (key, idx, value, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(key, nextIdx, JSON.stringify(value), expiresAt);

    // Trim to maxLength (keep newest)
    if (options?.maxLength) {
      const cutoff = nextIdx - options.maxLength;
      if (cutoff >= 0) {
        this.db
          .prepare('DELETE FROM chat_sdk_lists WHERE key = ? AND idx <= ?')
          .run(key, cutoff);
      }
    }
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const now = Date.now();
    const rows = this.db
      .prepare(
        'SELECT value FROM chat_sdk_lists WHERE key = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY idx ASC',
      )
      .all(key, now) as { value: string }[];
    return rows.map((r) => JSON.parse(r.value) as T);
  }

  // --- Cleanup ---

  private cleanup(): void {
    const now = Date.now();
    this.db
      .prepare('DELETE FROM chat_sdk_kv WHERE expires_at IS NOT NULL AND expires_at < ?')
      .run(now);
    this.db
      .prepare('DELETE FROM chat_sdk_locks WHERE expires_at < ?')
      .run(now);
    this.db
      .prepare('DELETE FROM chat_sdk_lists WHERE expires_at IS NOT NULL AND expires_at < ?')
      .run(now);
  }
}
