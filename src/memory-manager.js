/**
 * memory-manager.js — Daily + long-term memory management
 *
 * OpenClaw 互換のメモリ管理:
 * - appendDaily(entry) → workspace/memory/YYYY-MM-DD.md に Markdown 追記
 * - appendLongTerm(entry) → workspace/MEMORY.md に追記
 * - pruneOldDaily(retainDays) → 古い日次ファイルを削除
 *
 * 全 append 操作は withLock() で排他制御（将来の DM/group 並列に備える）
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDir,
  fileExists,
  atomicWriteText,
  listFiles,
  withLock,
} from "./utils/storage.js";
import * as logger from "./utils/logger.js";

const MODULE = "memory";

export class MemoryManager {
  /**
   * @param {object} opts
   * @param {string} opts.workspacePath - workspace/ ディレクトリ
   * @param {number} [opts.retainDays=30] - 日次メモリの保持日数
   */
  constructor({ workspacePath, retainDays = 30 }) {
    this.workspacePath = workspacePath;
    this.memoryDir = path.join(workspacePath, "memory");
    this.retainDays = retainDays;
  }

  async init() {
    await ensureDir(this.memoryDir);
  }

  /**
   * 日次メモリに追記
   * workspace/memory/YYYY-MM-DD.md に Markdown 形式で追記
   *
   * @param {object} entry
   * @param {string} entry.title - エントリタイトル
   * @param {string} entry.body - エントリ本文
   */
  async appendDaily(entry) {
    const dateStr = formatDate(new Date());
    const filePath = path.join(this.memoryDir, `${dateStr}.md`);
    const lockPath = filePath + ".lock";

    const timeStr = new Date().toISOString().slice(11, 19);
    const line = `\n## ${timeStr} — ${entry.title}\n\n${entry.body}\n`;

    await withLock(lockPath, async () => {
      const exists = await fileExists(filePath);
      if (!exists) {
        const header = `# Daily Log — ${dateStr}\n`;
        await atomicWriteText(filePath, header + line);
      } else {
        await fs.appendFile(filePath, line, "utf-8");
      }
    });

    logger.debug(MODULE, "daily memory appended", { date: dateStr, title: entry.title });
  }

  /**
   * 長期メモリに追記
   * workspace/MEMORY.md にセクション追記
   *
   * @param {object} entry
   * @param {string} entry.title - エントリタイトル
   * @param {string} entry.body - エントリ本文
   */
  async appendLongTerm(entry) {
    const filePath = path.join(this.workspacePath, "MEMORY.md");
    const lockPath = filePath + ".lock";

    const dateStr = formatDate(new Date());
    const line = `\n## ${entry.title} (${dateStr})\n\n${entry.body}\n`;

    await withLock(lockPath, async () => {
      const exists = await fileExists(filePath);
      if (!exists) {
        await atomicWriteText(filePath, `# Long-Term Memory\n${line}`);
      } else {
        await fs.appendFile(filePath, line, "utf-8");
      }
    });

    logger.debug(MODULE, "long-term memory appended", { title: entry.title });
  }

  /**
   * 古い日次ログをクリーンアップ
   * retainDays より古い YYYY-MM-DD.md ファイルを削除
   *
   * @returns {number} 削除したファイル数
   */
  async pruneOldDaily() {
    const files = await listFiles(this.memoryDir, ".md");
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retainDays);
    const cutoffStr = formatDate(cutoff);

    let pruned = 0;
    for (const file of files) {
      const dateStr = file.replace(".md", "");
      // YYYY-MM-DD 形式のみ対象（.gitkeep 等は無視）
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < cutoffStr) {
        await fs.unlink(path.join(this.memoryDir, file)).catch(() => {});
        logger.info(MODULE, "pruned old daily memory", { file });
        pruned++;
      }
    }
    return pruned;
  }
}

/**
 * 日付を YYYY-MM-DD 形式にフォーマット
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
