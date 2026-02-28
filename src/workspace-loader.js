/**
 * workspace-loader.js — Workspace context loader
 *
 * OpenClaw 互換のワークスペースコンテキストローダー:
 * セッションタイプ別に異なる .md ファイルを読み込み、
 * XML タグで囲んだコンテキスト文字列を組み立てる。
 *
 * セッションタイプ:
 * - "main": 全ファイルロード（長期メモリ含む）
 * - "cron": 軽量（SOUL + IDENTITY のみ）
 * - "group": 中間（MEMORY.md は読まない → GROUP_MEMORY.md を使用）
 *
 * トークン圧迫対策:
 * - 上限 maxContextChars（デフォルト 8000 文字）
 * - 削りにくい順に優先: SOUL/IDENTITY → today/yesterday → USER/TOOLS → MEMORY
 */

import fs from "node:fs/promises";
import path from "node:path";
import * as logger from "./utils/logger.js";

const MODULE = "workspace-loader";

/**
 * ロードプロファイル定義
 * always: 必須ファイル（欠落時は warn）
 * optional: あれば読む（なくてもサイレント）
 * daily: 日次メモリ（today + yesterday）をロードするか
 * bootstrap: BOOTSTRAP.md を確認するか
 */
const LOAD_PROFILES = {
  main: {
    always: ["SOUL.md", "USER.md"],
    optional: ["IDENTITY.md", "AGENTS.md", "TOOLS.md", "MEMORY.md"],
    daily: true,
    bootstrap: true,
  },
  cron: {
    always: ["SOUL.md"],
    optional: ["IDENTITY.md", "AGENTS.md"],
    daily: false,
    bootstrap: false,
  },
  group: {
    always: ["SOUL.md", "USER.md"],
    optional: ["IDENTITY.md", "AGENTS.md", "GROUP_MEMORY.md"],
    daily: true,
    bootstrap: false,
  },
};

/**
 * ファイルを安全に読み取る（存在しなければ null）
 */
async function readFileSafe(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.trim() || null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
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

/**
 * ワークスペースコンテキストを組み立てる
 *
 * @param {object} opts
 * @param {string} opts.workspacePath - workspace/ ディレクトリ
 * @param {string} [opts.sessionType="main"] - "main" | "cron" | "group"
 * @param {number} [opts.maxContextChars=8000] - コンテキスト文字数上限
 * @returns {Promise<{context: string, loadedFiles: string[], bootstrapFound: boolean}>}
 */
export async function loadWorkspaceContext({
  workspacePath,
  sessionType = "main",
  maxContextChars = 8000,
}) {
  const profile = LOAD_PROFILES[sessionType] || LOAD_PROFILES.main;

  // 優先度順にセクションを蓄積
  // priority: 1 = 最優先（削らない）, 2 = 中, 3 = 最後に削る
  const sections = [];
  const loadedFiles = [];
  let bootstrapFound = false;

  // 1. BOOTSTRAP.md チェック（最優先、存在すれば全他ファイルに優先）
  if (profile.bootstrap) {
    const content = await readFileSafe(path.join(workspacePath, "BOOTSTRAP.md"));
    if (content) {
      sections.push({ label: "BOOTSTRAP", content, priority: 1 });
      loadedFiles.push("BOOTSTRAP.md");
      bootstrapFound = true;
    }
  }

  // 2. always ファイル（必須 — 欠落時は warn）
  for (const filename of profile.always) {
    const content = await readFileSafe(path.join(workspacePath, filename));
    if (content) {
      const label = filename.replace(".md", "").toUpperCase();
      sections.push({ label, content, priority: 1 });
      loadedFiles.push(filename);
    } else {
      logger.warn(MODULE, `required workspace file missing: ${filename}`, { workspacePath });
    }
  }

  // 3. 日次メモリ（today + yesterday）— priority 2
  if (profile.daily) {
    const memoryDir = path.join(workspacePath, "memory");
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    for (const date of [yesterday, today]) {
      const dateStr = formatDate(date);
      const content = await readFileSafe(path.join(memoryDir, `${dateStr}.md`));
      if (content) {
        sections.push({ label: `DAILY_MEMORY_${dateStr}`, content, priority: 2 });
        loadedFiles.push(`memory/${dateStr}.md`);
      }
    }
  }

  // 4. optional ファイル — priority に応じて設定
  for (const filename of profile.optional) {
    const content = await readFileSafe(path.join(workspacePath, filename));
    if (content) {
      const label = filename.replace(".md", "").toUpperCase();
      // MEMORY / GROUP_MEMORY は priority 3（肥大しやすいので最後に削る）
      const isMemory = filename.includes("MEMORY");
      sections.push({ label, content, priority: isMemory ? 3 : 2 });
      loadedFiles.push(filename);
    }
  }

  // 5. トークン圧迫対策: 優先度の低いものから削る
  const context = buildContextWithLimit(sections, maxContextChars);

  return { context, loadedFiles, bootstrapFound };
}

/**
 * セクションを XML タグで囲み、上限に収める
 * priority の低い（数値が大きい）セクションから truncate
 */
function buildContextWithLimit(sections, maxChars) {
  if (sections.length === 0) return "";

  // まず全体を組み立て
  const formatted = sections.map(
    (s) => `<${s.label}>\n${s.content}\n</${s.label}>`
  );

  let result = formatted.join("\n\n");

  if (result.length <= maxChars) {
    return result;
  }

  // 超過: priority の高いものから残し、低いものを削る
  // priority 3 → 2 → 1 の順で削除を試みる
  logger.warn(MODULE, "context exceeds limit, truncating", {
    totalChars: result.length,
    maxChars,
  });

  const sortedByPriority = [...sections].sort((a, b) => a.priority - b.priority);
  const kept = [];
  let totalLen = 0;

  for (const section of sortedByPriority) {
    const tag = `<${section.label}>\n${section.content}\n</${section.label}>`;
    const newLen = totalLen + tag.length + (kept.length > 0 ? 2 : 0); // +2 for \n\n

    if (newLen <= maxChars) {
      kept.push({ ...section, tag });
      totalLen = newLen;
    } else {
      // この section は入りきらない — truncate して入れるか判断
      const remaining = maxChars - totalLen - (kept.length > 0 ? 2 : 0);
      if (remaining > 100) {
        // 100文字以上残りがあれば truncate して入れる
        const truncatedContent = section.content.slice(0, remaining - 50) + "\n\n[... truncated]";
        const truncTag = `<${section.label}>\n${truncatedContent}\n</${section.label}>`;
        kept.push({ ...section, tag: truncTag });
      }
      break; // これ以降は入らない
    }
  }

  // 元の順序（挿入順）に戻す
  const original = sections.map((s) => s.label);
  kept.sort((a, b) => original.indexOf(a.label) - original.indexOf(b.label));

  return kept.map((s) => s.tag).join("\n\n");
}
