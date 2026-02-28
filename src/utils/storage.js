/**
 * storage.js — Atomic file I/O with crash resistance
 *
 * OpenClaw 互換の永続化レイヤー:
 * - atomicWriteJSON: .tmp → rename パターン（プロセス落ち耐性）
 * - withLock: .lock ファイルで排他制御（stale lock 自動解放）
 * - ensureDir: ディレクトリ再帰作成
 */

import fs from "node:fs/promises";
import path from "node:path";

const LOCK_TTL_MS = 30_000; // stale lock は 30秒で自動解放
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_MAX_WAIT_MS = 10_000;

/**
 * Atomic JSON write: .tmp に書いてから rename
 * プロセスが途中で落ちても、元ファイルは壊れない
 */
export async function atomicWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

/**
 * Atomic text write (non-JSON)
 */
export async function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, text, "utf-8");
  await fs.rename(tmp, filePath);
}

/**
 * Read JSON file, return null if not found
 */
export async function readJSON(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * File lock with O_EXCL (exclusive create)
 * - stale lock 自動解放 (TTL: 30s)
 * - 最大待機時間付きリトライ
 *
 * IMPORTANT: 短時間 I/O 専用（sessions.json, jobs.json の更新など）。
 * TTL=30s なので、長時間処理（ネットワーク送信等）では使わないこと。
 * 長時間処理の排他には .processing フラグ (O_EXCL + configurable stale) を使用。
 */
export async function withLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  while (true) {
    try {
      // O_EXCL: ファイルが既に存在すればエラー
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      await handle.close();
      break; // lock 取得成功
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      // stale lock チェック
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
          // stale lock → 強制解放
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // lock ファイルが既に消えた → retry
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Lock timeout: ${lockPath}`);
      }

      // wait して retry
      await sleep(LOCK_RETRY_INTERVAL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}

/**
 * ディレクトリ再帰作成（既存なら何もしない）
 */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * ファイル存在チェック
 */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * ファイル一覧取得（ディレクトリスキャン）
 */
export async function listFiles(dirPath, ext) {
  try {
    const entries = await fs.readdir(dirPath);
    if (ext) return entries.filter((e) => e.endsWith(ext));
    return entries;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * JSONL append（セッション履歴等の追記用）
 */
export async function appendJSONL(filePath, record) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
}

/**
 * JSONL 全読み込み
 */
export async function readJSONL(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
