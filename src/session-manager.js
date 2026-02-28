/**
 * session-manager.js — OpenClaw-compatible session management
 *
 * OpenClaw 互換のセッション管理:
 *
 * 構造:
 *   data/sessions/{agentId}/
 *   ├── sessions.json       ← メタデータ
 *   └── {sessionId}.jsonl   ← メッセージ履歴 (append-only)
 *
 * 機能:
 * - resolve(sessionKey, agentId) → 既存セッション返却 or 新規作成
 * - shouldReset(entry) → daily (4:00 AM) / idle (24h) のいずれか先
 * - appendMessage / loadMessages → JSONL I/O
 * - archiveSession → .archive/ に移動
 *
 * Phase 1 の割り切り:
 * - compaction は Phase 2
 * - memory flush は Phase 2
 * - reset policy は daily + idle の2つだけ
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJSON,
  readJSON,
  ensureDir,
  appendJSONL,
  readJSONL,
  withLock,
} from "./utils/storage.js";
import * as logger from "./utils/logger.js";

const MODULE = "session";

export class SessionManager {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir - data/sessions/
   * @param {object} [opts.resetPolicy]
   * @param {string} [opts.resetPolicy.daily="04:00"] - リセット時刻 (HH:MM)
   * @param {number} [opts.resetPolicy.idleMs=86400000] - アイドルリセット (24h)
   */
  constructor({
    dataDir,
    resetPolicy = { daily: "04:00", idleMs: 86_400_000 },
  }) {
    this.dataDir = dataDir;
    this.resetPolicy = resetPolicy;
  }

  async init() {
    await ensureDir(this.dataDir);
  }

  /**
   * セッションを解決: 既存があれば返却、なければ新規作成
   * リセット条件に該当すれば新しいセッションを作成
   *
   * @param {string} sessionKey - buildSessionKey() の結果
   * @param {string} agentId
   * @returns {Promise<{sessionId: string, isNew: boolean}>}
   */
  async resolve(sessionKey, agentId) {
    const agentDir = path.join(this.dataDir, agentId);
    await ensureDir(agentDir);

    const metaFile = path.join(agentDir, "sessions.json");
    const lockPath = metaFile + ".lock";

    return withLock(lockPath, async () => {
      const meta = (await readJSON(metaFile)) || {};
      const entry = meta[sessionKey];

      // 既存セッションがあるか
      if (entry) {
        // リセット判定
        if (this._shouldReset(entry)) {
          logger.info(MODULE, "session reset", { sessionKey, agentId, reason: "daily/idle" });
          // 古いセッションをアーカイブ
          await this._archive(agentId, entry.sessionId);
          // 新しいセッション作成
          const newEntry = this._createEntry();
          meta[sessionKey] = newEntry;
          await atomicWriteJSON(metaFile, meta);
          return { sessionId: newEntry.sessionId, isNew: true };
        }

        // 既存を更新して返却
        entry.updatedAt = Date.now();
        await atomicWriteJSON(metaFile, meta);
        return { sessionId: entry.sessionId, isNew: false };
      }

      // 新規作成
      const newEntry = this._createEntry();
      meta[sessionKey] = newEntry;
      await atomicWriteJSON(metaFile, meta);

      logger.info(MODULE, "session created", { sessionKey, agentId, sessionId: newEntry.sessionId });
      return { sessionId: newEntry.sessionId, isNew: true };
    });
  }

  /**
   * リセット判定: daily (4:00 AM 跨ぎ) or idle (24h)
   */
  _shouldReset(entry) {
    const now = Date.now();
    const updatedAt = entry.updatedAt || entry.createdAt;

    // Idle reset: 最終更新から idleMs 経過
    if (now - updatedAt > this.resetPolicy.idleMs) {
      return true;
    }

    // Daily reset: updatedAt から now の間に daily 時刻が1つでも存在するか
    // これにより、日跨ぎが複数あっても正しく判定される
    // 例: updatedAt=2/26 03:50, now=2/28 03:30 → 2/26 04:00 が間にある → true
    const [hours, minutes] = this.resetPolicy.daily.split(":").map(Number);

    // updatedAt の次の daily 時刻を求める
    const nextReset = new Date(updatedAt);
    nextReset.setHours(hours, minutes, 0, 0);
    if (nextReset.getTime() <= updatedAt) {
      // updatedAt が daily 時刻以降 → 翌日の daily 時刻
      nextReset.setDate(nextReset.getDate() + 1);
    }

    // 次の daily 時刻が now 以前なら跨いでいる
    if (nextReset.getTime() <= now) {
      return true;
    }

    return false;
  }

  /**
   * メッセージを追記
   */
  async appendMessage(agentId, sessionId, message) {
    const filePath = path.join(this.dataDir, agentId, `${sessionId}.jsonl`);
    await appendJSONL(filePath, {
      ...message,
      ts: message.ts || Date.now(),
    });
  }

  /**
   * メッセージ履歴を読み込み
   */
  async loadMessages(agentId, sessionId) {
    const filePath = path.join(this.dataDir, agentId, `${sessionId}.jsonl`);
    return readJSONL(filePath);
  }

  /**
   * セッションメタデータを更新
   */
  async updateMeta(sessionKey, agentId, updates) {
    const metaFile = path.join(this.dataDir, agentId, "sessions.json");
    const lockPath = metaFile + ".lock";

    await withLock(lockPath, async () => {
      const meta = (await readJSON(metaFile)) || {};
      if (meta[sessionKey]) {
        Object.assign(meta[sessionKey], updates, { updatedAt: Date.now() });
        await atomicWriteJSON(metaFile, meta);
      }
    });
  }

  /**
   * セッション一覧を取得
   */
  async listSessions(agentId) {
    const metaFile = path.join(this.dataDir, agentId, "sessions.json");
    return (await readJSON(metaFile)) || {};
  }

  /**
   * セッションをアーカイブ (.archive/ に移動)
   */
  async _archive(agentId, sessionId) {
    const agentDir = path.join(this.dataDir, agentId);
    const archiveDir = path.join(agentDir, ".archive");
    await ensureDir(archiveDir);

    const src = path.join(agentDir, `${sessionId}.jsonl`);
    const dst = path.join(archiveDir, `${sessionId}.jsonl`);

    try {
      await fs.rename(src, dst);
      logger.debug(MODULE, "archived", { agentId, sessionId });
    } catch (err) {
      if (err.code !== "ENOENT") {
        logger.warn(MODULE, "archive failed", { agentId, sessionId, err: err.message });
      }
    }
  }

  /**
   * 新しいセッションエントリを作成
   */
  _createEntry() {
    const now = Date.now();
    return {
      sessionId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      model: null,
      totalTokens: 0,
    };
  }
}
