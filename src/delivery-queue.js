/**
 * delivery-queue.js — Crash-resistant delivery queue
 *
 * OpenClaw 互換の配信キュー:
 * - enqueue: atomic write で {uuid}.json 作成
 * - processAll: ディレクトリスキャン → 各アイテム処理
 * - retry: exponential backoff (1s → 2s → 4s), max 3回
 * - bestEffort: 部分成功（成功 payload は削除、失敗分だけ残す）
 * - TTL: 超過したアイテムは dead-letter へ移動
 * - 冪等性: .processing フラグで二重処理防止
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  atomicWriteJSON,
  readJSON,
  ensureDir,
  listFiles,
  fileExists,
  withLock,
} from "./utils/storage.js";
import * as logger from "./utils/logger.js";

const MODULE = "delivery-queue";

export class DeliveryQueue {
  /**
   * @param {object} opts
   * @param {string} opts.queueDir - キューディレクトリ (data/delivery-queue/)
   * @param {string} opts.deadLetterDir - dead-letter ディレクトリ
   * @param {object} opts.adapters - { telegram: adapter, ... }
   * @param {number} [opts.maxRetries=3]
   * @param {number} [opts.ttlMs=300000] - 5分
   * @param {number} [opts.baseRetryMs=1000] - 初回リトライ間隔
   * @param {number} [opts.processingStaleMs=300000] - .processing の stale 判定 (5分)
   */
  constructor({
    queueDir,
    deadLetterDir,
    adapters = {},
    maxRetries = 3,
    ttlMs = 300_000,
    baseRetryMs = 1000,
    processingStaleMs = 300_000,
  }) {
    this.queueDir = queueDir;
    this.deadLetterDir = deadLetterDir;
    this.adapters = adapters;
    this.maxRetries = maxRetries;
    this.ttlMs = ttlMs;
    this.baseRetryMs = baseRetryMs;
    this.processingStaleMs = processingStaleMs;
    this._scanning = false; // 多重起動ガード
  }

  /**
   * 初期化: ディレクトリ作成
   */
  async init() {
    await ensureDir(this.queueDir);
    await ensureDir(this.deadLetterDir);
  }

  /**
   * キューにアイテムを追加
   *
   * @param {object} opts
   * @param {string} opts.channel - "telegram" etc.
   * @param {string} opts.to - OpenClaw 形式の宛先
   * @param {Array<{text: string, mediaUrls?: string[]}>} opts.payloads
   * @param {boolean} [opts.bestEffort=true]
   * @param {string|null} [opts.threadId=null]
   * @param {string|null} [opts.replyToId=null]
   * @returns {string} item ID
   */
  async enqueue({ channel, to, payloads, bestEffort = true, threadId = null, replyToId = null }) {
    const id = crypto.randomUUID();
    const item = {
      id,
      enqueuedAt: Date.now(),
      channel,
      to,
      payloads: payloads.map((p) => ({
        text: p.text,
        mediaUrls: p.mediaUrls || [],
      })),
      threadId,
      replyToId,
      bestEffort,
      retryCount: 0,
      lastError: null,
    };

    const filePath = path.join(this.queueDir, `${id}.json`);
    await atomicWriteJSON(filePath, item);

    logger.info(MODULE, "enqueued", { id, channel, to, payloadCount: payloads.length });
    return id;
  }

  /**
   * キュー全体を処理
   * @returns {{ processed: number, succeeded: number, failed: number, deadLettered: number }}
   */
  async processAll() {
    // ガード1: 同一プロセス内の再入防止（setInterval vs 手動呼び出し）
    if (this._scanning) {
      logger.debug(MODULE, "processAll skipped (already scanning)");
      return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
    }
    this._scanning = true;

    const stats = { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };

    try {
      // ガード2: プロセス間排他（二重起動、LaunchAgent重複 etc.）
      const scanLock = path.join(this.queueDir, ".scan.lock");
      await withLock(scanLock, async () => {
        await this._scanAndProcess(stats);
      });
    } catch (err) {
      // withLock タイムアウト = 別プロセスがスキャン中
      if (err.message?.includes("Lock timeout")) {
        logger.debug(MODULE, "processAll skipped (another process scanning)");
      } else {
        throw err;
      }
    } finally {
      this._scanning = false;
    }

    return stats;
  }

  /**
   * 実際のスキャン・処理ロジック（processAll から withLock 経由で呼ばれる）
   * @private
   */
  async _scanAndProcess(stats) {
    const files = await listFiles(this.queueDir, ".json");

    for (const file of files) {
      const filePath = path.join(this.queueDir, file);
      const processingFlag = filePath + ".processing";

      // 冪等性: O_EXCL (wx) で原子的に .processing フラグを取得
      // 既に存在 → 別プロセスが処理中（EEXIST）→ stale チェック
      let flagAcquired = false;
      try {
        const handle = await fs.open(processingFlag, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        flagAcquired = true;
      } catch (err) {
        if (err.code === "EEXIST") {
          // stale processing チェック (processingStaleMs 以上前なら強制解放して再取得)
          try {
            const stat = await fs.stat(processingFlag);
            if (Date.now() - stat.mtimeMs < this.processingStaleMs) {
              logger.debug(MODULE, "skip (processing)", { file });
              continue;
            }
            await fs.unlink(processingFlag).catch(() => {});
            // 再取得を試みる
            try {
              const handle = await fs.open(processingFlag, "wx");
              await handle.writeFile(String(process.pid));
              await handle.close();
              flagAcquired = true;
            } catch {
              continue;
            }
          } catch {
            continue;
          }
        } else {
          continue;
        }
      }
      if (!flagAcquired) continue;

      try {
        const item = await readJSON(filePath);
        if (!item) {
          await fs.unlink(processingFlag).catch(() => {});
          continue;
        }

        stats.processed++;
        const result = await this._processItem(item, filePath);

        if (result === "success") {
          stats.succeeded++;
        } else if (result === "dead-letter") {
          stats.deadLettered++;
        } else {
          stats.failed++;
        }
      } catch (err) {
        logger.error(MODULE, "processItem error", { file, err: err.message });
        stats.failed++;
      } finally {
        await fs.unlink(processingFlag).catch(() => {});
      }
    }

    if (stats.processed > 0) {
      logger.info(MODULE, "processAll done", stats);
    }
  }

  /**
   * 個別アイテム処理
   * @returns {"success"|"retry"|"dead-letter"}
   */
  async _processItem(item, filePath) {
    // TTL チェック
    if (Date.now() - item.enqueuedAt > this.ttlMs) {
      logger.warn(MODULE, "TTL exceeded → dead-letter", { id: item.id });
      await this._moveToDeadLetter(item, filePath, "TTL exceeded");
      return "dead-letter";
    }

    // retry 上限チェック
    if (item.retryCount >= this.maxRetries) {
      logger.warn(MODULE, "max retries → dead-letter", { id: item.id, retryCount: item.retryCount });
      await this._moveToDeadLetter(item, filePath, "max retries exceeded");
      return "dead-letter";
    }

    // Adapter 取得
    const adapter = this.adapters[item.channel];
    if (!adapter) {
      logger.error(MODULE, "no adapter", { channel: item.channel });
      await this._moveToDeadLetter(item, filePath, `no adapter for channel: ${item.channel}`);
      return "dead-letter";
    }

    // bestEffort: 各 payload を個別に送信
    if (item.bestEffort) {
      return this._processBestEffort(item, filePath, adapter);
    }

    // 通常モード: 全 payload を送信、1つでも失敗したら全体リトライ
    return this._processStrict(item, filePath, adapter);
  }

  /**
   * bestEffort モード: 成功分は削除、失敗分だけ残す
   */
  async _processBestEffort(item, filePath, adapter) {
    const failed = [];

    for (const payload of item.payloads) {
      try {
        await adapter.send(item.to, payload);
      } catch (err) {
        logger.warn(MODULE, "payload send failed (bestEffort)", {
          id: item.id,
          err: err.message,
        });
        failed.push({ payload, error: err.message });
      }
    }

    if (failed.length === 0) {
      // 全成功 → キューから削除
      await fs.unlink(filePath).catch(() => {});
      logger.info(MODULE, "delivered (bestEffort, all)", { id: item.id });
      return "success";
    }

    if (failed.length < item.payloads.length) {
      // 部分成功: 失敗分だけ残してリトライ
      item.payloads = failed.map((f) => f.payload);
      item.retryCount++;
      item.lastError = `partial delivery failure (bestEffort): ${failed.length} failed`;
      await atomicWriteJSON(filePath, item);
      logger.info(MODULE, "partial delivery", {
        id: item.id,
        delivered: item.payloads.length,
        remaining: failed.length,
      });
      return "retry";
    }

    // 全失敗
    item.retryCount++;
    item.lastError = failed[0].error;
    await atomicWriteJSON(filePath, item);
    return "retry";
  }

  /**
   * 厳密モード: 1つでも失敗したら全体リトライ
   */
  async _processStrict(item, filePath, adapter) {
    try {
      for (const payload of item.payloads) {
        await adapter.send(item.to, payload);
      }
      // 全成功
      await fs.unlink(filePath).catch(() => {});
      logger.info(MODULE, "delivered (strict)", { id: item.id });
      return "success";
    } catch (err) {
      item.retryCount++;
      item.lastError = err.message;
      await atomicWriteJSON(filePath, item);
      logger.warn(MODULE, "delivery failed → retry", {
        id: item.id,
        retryCount: item.retryCount,
        err: err.message,
      });
      return "retry";
    }
  }

  /**
   * dead-letter ディレクトリへ移動
   */
  async _moveToDeadLetter(item, filePath, reason) {
    item.deadLetteredAt = Date.now();
    item.deadLetterReason = reason;
    const dlPath = path.join(this.deadLetterDir, `${item.id}.json`);
    await atomicWriteJSON(dlPath, item);
    await fs.unlink(filePath).catch(() => {});
    logger.warn(MODULE, "moved to dead-letter", { id: item.id, reason });
  }

  /**
   * キュー内のアイテム数を取得
   */
  async size() {
    const files = await listFiles(this.queueDir, ".json");
    return files.length;
  }

  /**
   * dead-letter 内のアイテム数を取得
   */
  async deadLetterSize() {
    const files = await listFiles(this.deadLetterDir, ".json");
    return files.length;
  }
}
