/**
 * index.js — openclaw-cc entrypoint
 *
 * Reproduces OpenClaw's automation core using Claude Code (`claude -p`)
 * + direct Bot APIs (no gateway).
 *
 * 起動順序:
 * 1. 設定読み込み (config/default.json)
 * 2. モジュール初期化（依存順）
 *    storage → logger → telegram → deliveryQueue → agentRunner → sessionManager
 * 3. 起動時 delivery queue 未処理スキャン
 * 4. Telegram Poller 起動（受信、allowedChatIds 設定時のみ）
 * 5. Cron Scheduler 起動
 * 6. 定期 delivery queue スキャン (30s)
 * 7. graceful shutdown (SIGTERM/SIGINT)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, ensureDir } from "./utils/storage.js";
import * as logger from "./utils/logger.js";
import { DeliveryQueue } from "./delivery-queue.js";
import { AgentRunner } from "./agent-runner.js";
import { CronScheduler } from "./cron-scheduler.js";
import { SessionManager } from "./session-manager.js";
import { createAdapter as createTelegramAdapter, sendMessage as telegramSendMessage } from "./channel-adapters/telegram.js";
import { TelegramPoller } from "./channel-receivers/telegram-poller.js";
import { MemoryManager } from "./memory-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MODULE = "main";

/**
 * .env ファイルを読み込み process.env に注入（依存ゼロ版）
 */
async function loadEnv(envPath) {
  try {
    const raw = await fs.readFile(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // クォート除去
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // .env がなければスキップ
  }
}

/**
 * 設定読み込み（config/default.json、なければデフォルト値）
 */
async function loadConfig() {
  const configPath = path.join(ROOT, "config", "default.json");
  const config = await readJSON(configPath);

  // デフォルト値とマージ
  return {
    agents: {
      defaults: {
        model: "sonnet",
        timeoutSeconds: 300,
      },
      ...config?.agents,
    },
    delivery: {
      scanIntervalMs: 30_000,
      maxRetries: 3,
      ttlMs: 300_000,
      processingStaleMs: 300_000,
      ...config?.delivery,
    },
    cron: {
      jobsFile: path.join(ROOT, "data", "cron", "jobs.json"),
      ...config?.cron,
    },
    session: {
      resetPolicy: {
        daily: "04:00",
        idleMs: 86_400_000,
      },
      dataDir: path.join(ROOT, "data", "sessions"),
      ...config?.session,
    },
    telegram: {
      defaultChatId: "",
      defaultTopicId: null,
      ...config?.telegram,
    },
  };
}

async function main() {
  // 1. .env と設定読み込み
  await loadEnv(path.join(ROOT, ".env"));
  const config = await loadConfig();

  logger.info(MODULE, "openclaw-cc starting", {
    nodeVersion: process.version,
    pid: process.pid,
  });

  // 2. ディレクトリ確保
  await ensureDir(path.join(ROOT, "data", "delivery-queue"));
  await ensureDir(path.join(ROOT, "data", "dead-letter"));
  await ensureDir(path.join(ROOT, "data", "cron", "runs"));
  await ensureDir(config.session.dataDir);

  // 3. Channel Adapters
  const adapters = {};
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    adapters.telegram = createTelegramAdapter(botToken);
    logger.info(MODULE, "telegram adapter loaded");
  } else {
    logger.warn(MODULE, "TELEGRAM_BOT_TOKEN not set — telegram delivery disabled");
  }

  // 4. Delivery Queue
  const deliveryQueue = new DeliveryQueue({
    queueDir: path.join(ROOT, "data", "delivery-queue"),
    deadLetterDir: path.join(ROOT, "data", "dead-letter"),
    adapters,
    maxRetries: config.delivery.maxRetries,
    ttlMs: config.delivery.ttlMs,
    processingStaleMs: config.delivery.processingStaleMs,
  });
  await deliveryQueue.init();

  // 5. Agent Runner
  const agentRunner = new AgentRunner({
    sessionsDir: config.session.dataDir,
  });
  await agentRunner.init();

  // 6. Session Manager
  const sessionManager = new SessionManager({
    dataDir: config.session.dataDir,
    resetPolicy: config.session.resetPolicy,
  });
  await sessionManager.init();

  // 7. Cron Scheduler
  const cronScheduler = new CronScheduler({
    jobsFile: config.cron.jobsFile,
    agentRunner,
    deliveryQueue,
    sessionManager,
  });

  // 7.5. Memory Manager
  const memoryManager = new MemoryManager({
    workspacePath: path.join(ROOT, "workspace"),
    retainDays: 30,
  });
  await memoryManager.init();
  logger.info(MODULE, "memory manager initialized");

  // 8. 起動時 delivery queue スキャン
  const initialStats = await deliveryQueue.processAll();
  if (initialStats.processed > 0) {
    logger.info(MODULE, "initial queue drain", initialStats);
  }

  // 9. Telegram Poller（受信）
  let telegramPoller = null;
  if (botToken && config.telegram.allowedChatIds?.length > 0) {
    telegramPoller = new TelegramPoller({
      botToken,
      allowedChatIds: config.telegram.allowedChatIds,
      agentRunner,
      sessionManager,
      sendMessage: telegramSendMessage,
      stateDir: path.join(ROOT, "data", "telegram"),
      pollingIntervalMs: config.telegram.pollingIntervalMs || 3000,
      agentConfig: {
        model: config.agents.defaults.model,
        timeoutMs: (config.agents.defaults.timeoutSeconds || 300) * 1000,
        workspacePath: path.join(ROOT, "workspace"),
        allowedTools: config.agents.defaults.allowedTools || "Bash,Read,Write,Edit,Grep,Glob",
        maxBudgetUsd: config.agents.defaults.maxBudgetUsd,
        sessionPersistence: config.telegram.sessionPersistence !== false,
      },
      memoryManager,
    });
    await telegramPoller.start();
    logger.info(MODULE, "telegram poller started", {
      allowedChats: config.telegram.allowedChatIds.length,
    });
  }

  // 10. Cron 起動
  await cronScheduler.start();

  // 11. 定期 delivery queue スキャン
  const deliveryScanInterval = setInterval(async () => {
    try {
      await deliveryQueue.processAll();
    } catch (err) {
      logger.error(MODULE, "delivery scan error", { err: err.message });
    }
  }, config.delivery.scanIntervalMs);

  logger.info(MODULE, "openclaw-cc running", {
    deliveryScanMs: config.delivery.scanIntervalMs,
  });

  // 12. Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(MODULE, `${signal} received, shutting down...`);
    clearInterval(deliveryScanInterval);
    if (telegramPoller) await telegramPoller.stop();
    await cronScheduler.stop();
    // 最後にキュー処理
    await deliveryQueue.processAll();
    logger.info(MODULE, "shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error(MODULE, "fatal", { err: err.message, stack: err.stack });
  process.exit(1);
});
