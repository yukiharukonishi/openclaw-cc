/**
 * agent-runner.js — claude -p execution wrapper (two-tier)
 *
 * OpenClaw 互換の Agent 実行:
 *
 * Mode 1 (CLI session): claude -p --session-id UUID --model MODEL
 *   → Claude Code がセッションを自動管理。理想的。
 *
 * Mode 2 (JSONL fallback): 自前で履歴を JSONL 管理し、プロンプトに注入
 *   → Mode 1 が使えない場合の保険。
 *
 * Mode 3 (Stateless): claude -p --no-session-persistence
 *   → チャットメッセージ用。毎回新規セッション。telegram-bridge.js 互換。
 *
 * 初回実行時に Mode 1 を試し、成功すれば以後も Mode 1。
 * 失敗すれば Mode 2 にフォールバックし、結果をキャッシュ。
 * noSessionPersistence=true の場合は Mode 3（Stateless）を直接使用。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import * as logger from "./utils/logger.js";
import { appendJSONL, readJSONL, ensureDir } from "./utils/storage.js";
import { loadWorkspaceContext } from "./workspace-loader.js";

const MODULE = "agent-runner";

/** Mode 検出結果のキャッシュ */
let detectedMode = null; // "cli" | "jsonl" | null

export class AgentRunner {
  /**
   * @param {object} opts
   * @param {string} opts.sessionsDir - セッション JSONL 保存先
   * @param {string} [opts.claudeBin="claude"] - claude CLI パス
   * @param {number} [opts.defaultTimeoutMs=300000] - デフォルトタイムアウト (5分)
   */
  constructor({ sessionsDir, claudeBin = "claude", defaultTimeoutMs = 300_000 }) {
    this.sessionsDir = sessionsDir;
    this.claudeBin = claudeBin;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async init() {
    await ensureDir(this.sessionsDir);
  }

  /**
   * Agent 実行（二段構え）
   *
   * @param {object} opts
   * @param {string} opts.sessionId - セッションID (UUID)
   * @param {string} opts.agentId - エージェントID (サブディレクトリ名)
   * @param {string} [opts.model="sonnet"]
   * @param {string} opts.message - 実行プロンプト
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.systemPrompt] - カスタムシステムプロンプト
   * @param {string} [opts.workspacePath] - ワークスペースパス
   * @param {string} [opts.sessionType="main"] - セッションタイプ ("main"|"cron"|"group")
   * @param {boolean} [opts.noSessionPersistence=false] - true → --no-session-persistence 強制（チャット用）
   * @param {string} [opts.allowedTools] - 許可ツール ("Bash,Read,Write,Edit,Grep,Glob")
   * @param {string} [opts.maxBudgetUsd] - コスト上限 ("0.50")
   * @returns {Promise<{text: string, exitCode: number, mode: string}>}
   */
  async run({
    sessionId,
    agentId,
    model = "sonnet",
    message,
    timeoutMs,
    systemPrompt,
    workspacePath,
    sessionType,
    noSessionPersistence = false,
    allowedTools,
    maxBudgetUsd,
  }) {
    const timeout = timeoutMs || this.defaultTimeoutMs;

    // Workspace context 注入
    let effectiveSystemPrompt = systemPrompt || "";
    if (workspacePath) {
      try {
        const { context, loadedFiles } = await loadWorkspaceContext({
          workspacePath,
          sessionType: sessionType || "main",
        });
        if (context) {
          effectiveSystemPrompt = context + "\n\n" + effectiveSystemPrompt;
          logger.info(MODULE, "workspace context loaded", { files: loadedFiles });
        }
      } catch (err) {
        logger.warn(MODULE, "workspace context load failed, continuing without", {
          err: err.message,
        });
      }
    }

    // Mode 3: Stateless（チャットメッセージ用 — telegram-bridge.js 互換）
    if (noSessionPersistence) {
      return this._runStateless({
        model, message, timeout, systemPrompt: effectiveSystemPrompt,
        workspacePath, allowedTools, maxBudgetUsd,
      });
    }

    // Mode 自動検出（初回のみ）
    if (detectedMode === null) {
      detectedMode = await this._detectMode();
      logger.info(MODULE, `mode detected: ${detectedMode}`);
    }

    if (detectedMode === "cli") {
      return this._runCLI({ sessionId, agentId, model, message, timeout, systemPrompt: effectiveSystemPrompt, workspacePath });
    }

    return this._runJSONL({ sessionId, agentId, model, message, timeout, systemPrompt: effectiveSystemPrompt, workspacePath });
  }

  /**
   * Mode 検出: claude -p --session-id が動作するか確認
   */
  async _detectMode() {
    try {
      const result = await this._execClaude({
        args: ["-p", "--session-id", "00000000-0000-0000-0000-000000000000", "--model", "haiku"],
        input: 'Reply with exactly "OK" and nothing else.',
        timeoutMs: 30_000,
      });

      if (result.exitCode === 0 && result.stdout.trim().length > 0) {
        logger.info(MODULE, "CLI session mode available");
        return "cli";
      }
    } catch (err) {
      logger.warn(MODULE, "CLI session mode failed, falling back to JSONL", {
        err: err.message,
      });
    }

    return "jsonl";
  }

  /**
   * Mode 1: CLI セッション（理想）
   * claude -p --session-id UUID --model MODEL
   */
  async _runCLI({ sessionId, agentId, model, message, timeout, systemPrompt, workspacePath }) {
    const args = ["-p", "--session-id", sessionId, "--model", model];

    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    const result = await this._execClaude({
      args,
      input: message,
      timeoutMs: timeout,
      cwd: workspacePath,
    });

    logger.info(MODULE, "CLI run complete", {
      sessionId,
      agentId,
      model,
      exitCode: result.exitCode,
      outputLen: result.stdout.length,
    });

    return {
      text: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.exitCode,
      mode: "cli",
    };
  }

  /**
   * Mode 3: Stateless（チャット用 — telegram-bridge.js 互換）
   * claude -p --no-session-persistence --model MODEL
   * 毎回新規セッション。セッション再利用の問題を回避。
   */
  async _runStateless({ model, message, timeout, systemPrompt, workspacePath, allowedTools, maxBudgetUsd }) {
    const args = ["-p", "--model", model, "--no-session-persistence"];

    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }
    if (allowedTools) {
      args.push("--allowedTools", allowedTools);
    }
    if (maxBudgetUsd) {
      args.push("--max-budget-usd", maxBudgetUsd);
    }

    const result = await this._execClaude({
      args,
      input: message,
      timeoutMs: timeout,
      cwd: workspacePath,
    });

    logger.info(MODULE, "stateless run complete", {
      model,
      exitCode: result.exitCode,
      outputLen: result.stdout.length,
    });

    return {
      text: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.exitCode,
      mode: "stateless",
    };
  }

  /**
   * Mode 2: JSONL フォールバック
   * 過去の会話履歴をプロンプトに注入して claude -p に渡す
   */
  async _runJSONL({ sessionId, agentId, model, message, timeout, systemPrompt, workspacePath }) {
    const historyDir = path.join(this.sessionsDir, agentId);
    const historyFile = path.join(historyDir, `${sessionId}.jsonl`);

    // 過去履歴を読み込み
    const history = await readJSONL(historyFile);

    // 履歴をコンテキストに変換
    let contextBlock = "";
    if (history.length > 0) {
      const recentHistory = history.slice(-20); // 直近20ターンのみ
      contextBlock =
        "<conversation_history>\n" +
        recentHistory
          .map((h) => `[${h.role}] ${h.content}`)
          .join("\n---\n") +
        "\n</conversation_history>\n\n";
    }

    const fullMessage = contextBlock + message;

    const args = ["-p", "--model", model, "--no-session-persistence"];

    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    const result = await this._execClaude({
      args,
      input: fullMessage,
      timeoutMs: timeout,
      cwd: workspacePath,
    });

    // 履歴に追記
    await appendJSONL(historyFile, {
      role: "user",
      content: message,
      ts: Date.now(),
    });
    await appendJSONL(historyFile, {
      role: "assistant",
      content: result.stdout.trim(),
      ts: Date.now(),
    });

    logger.info(MODULE, "JSONL run complete", {
      sessionId,
      agentId,
      model,
      exitCode: result.exitCode,
      historyLen: history.length,
      outputLen: result.stdout.length,
    });

    return {
      text: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.exitCode,
      mode: "jsonl",
    };
  }

  /**
   * claude CLI を子プロセスとして実行
   *
   * @param {object} opts
   * @param {string[]} opts.args
   * @param {string} opts.input - stdin に渡す入力
   * @param {number} opts.timeoutMs
   * @param {string} [opts.cwd]
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
   */
  _execClaude({ args, input, timeoutMs, cwd }) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      // ネスト防止: Claude Code 関連の環境変数を全除去（env -i 相当）
      for (const key of Object.keys(env)) {
        if (key.startsWith("CLAUDE") || key.startsWith("ANTHROPIC_")) {
          delete env[key];
        }
      }

      const proc = spawn(this.claudeBin, args, {
        env,
        cwd: cwd || process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // stdin にプロンプトを書き込み
      if (input) {
        proc.stdin.write(input);
        proc.stdin.end();
      }

      proc.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on("error", (err) => {
        if (err.code === "ETIMEDOUT" || err.killed) {
          reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Mode を強制リセット（テスト用）
   */
  static resetModeCache() {
    detectedMode = null;
  }

  /**
   * 現在の Mode を取得
   */
  static getDetectedMode() {
    return detectedMode;
  }
}
