/**
 * cron-scheduler.js — OpenClaw-compatible cron scheduler
 *
 * Phase 1 対応:
 * - kind: "every" — ms 間隔で繰り返し
 * - kind: "at" — 固定時刻で1回実行（deleteAfterRun 対応）
 * - kind: "cron" — Phase 2 で追加予定
 *
 * アルゴリズム:
 * 1. loadJobs → enabled のみフィルタ
 * 2. scheduleNext(job) → setTimeout で次回実行をセット
 * 3. runJob(job):
 *    a. session 解決
 *    b. agentRunner.run() 実行
 *    c. NO_REPLY 判定
 *    d. delivery queue に enqueue
 *    e. state 更新
 *    f. deleteAfterRun → ジョブ削除
 *    g. scheduleNext() → 次回登録
 *
 * stagger: hash(jobId) % staggerMs で同時刻ジョブをズラす
 */

import crypto from "node:crypto";
import { atomicWriteJSON, readJSON, withLock } from "./utils/storage.js";
import { buildSessionKey } from "./utils/session-key.js";
import * as logger from "./utils/logger.js";

const MODULE = "cron";

export class CronScheduler {
  /**
   * @param {object} opts
   * @param {string} opts.jobsFile - data/cron/jobs.json
   * @param {import('./agent-runner.js').AgentRunner} opts.agentRunner
   * @param {import('./delivery-queue.js').DeliveryQueue} opts.deliveryQueue
   * @param {import('./session-manager.js').SessionManager} opts.sessionManager
   */
  constructor({ jobsFile, agentRunner, deliveryQueue, sessionManager }) {
    this.jobsFile = jobsFile;
    this.agentRunner = agentRunner;
    this.deliveryQueue = deliveryQueue;
    this.sessionManager = sessionManager;
    this.timers = new Map(); // jobId → timeout handle
    this.running = new Set(); // 実行中ジョブID
    this._jobs = null; // キャッシュ
    this._stopped = false;
  }

  /**
   * スケジューラ起動
   */
  async start() {
    this._stopped = false;
    const data = await this._loadJobs();
    const jobs = data.jobs.filter((j) => j.enabled);

    logger.info(MODULE, `loaded ${jobs.length}/${data.jobs.length} enabled jobs`);

    for (const job of jobs) {
      this._scheduleNext(job);
    }
  }

  /**
   * スケジューラ停止
   */
  async stop() {
    this._stopped = true;
    // 全タイマー停止
    for (const [jobId, timer] of this.timers) {
      clearTimeout(timer);
      logger.debug(MODULE, "timer cleared", { jobId });
    }
    this.timers.clear();

    // 実行中ジョブの完了を待機（最大30秒）
    if (this.running.size > 0) {
      logger.info(MODULE, `waiting for ${this.running.size} running jobs...`);
      const deadline = Date.now() + 30_000;
      while (this.running.size > 0 && Date.now() < deadline) {
        await sleep(500);
      }
    }
  }

  /**
   * ジョブ一覧を返す
   */
  async getJobs() {
    const data = await this._loadJobs();
    return data.jobs;
  }

  /**
   * ジョブを追加
   */
  async addJob(job) {
    const lockPath = this.jobsFile + ".lock";
    await withLock(lockPath, async () => {
      const data = await this._loadJobs();
      data.jobs.push(job);
      await this._persistJobs(data);
    });

    if (job.enabled && !this._stopped) {
      this._scheduleNext(job);
    }

    logger.info(MODULE, "job added", { id: job.id, name: job.name });
  }

  /**
   * ジョブを削除
   */
  async removeJob(jobId) {
    // タイマー停止
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }

    const lockPath = this.jobsFile + ".lock";
    await withLock(lockPath, async () => {
      const data = await this._loadJobs();
      data.jobs = data.jobs.filter((j) => j.id !== jobId);
      await this._persistJobs(data);
    });

    logger.info(MODULE, "job removed", { id: jobId });
  }

  // ── Internal ──

  /**
   * 次回実行をスケジュール
   */
  _scheduleNext(job) {
    if (this._stopped) return;

    const delayMs = this._calculateDelay(job);
    if (delayMs === null) {
      logger.debug(MODULE, "no next run", { id: job.id, name: job.name });
      return;
    }

    const effectiveDelay = Math.max(0, delayMs);

    logger.debug(MODULE, "scheduled", {
      id: job.id,
      name: job.name,
      delayMs: effectiveDelay,
      nextAt: new Date(Date.now() + effectiveDelay).toISOString(),
    });

    const timer = setTimeout(() => this._runJob(job), effectiveDelay);
    // unref() でタイマーがプロセスを生かし続けないようにする
    timer.unref();
    this.timers.set(job.id, timer);
  }

  /**
   * 次回実行までの遅延を計算
   */
  _calculateDelay(job) {
    const schedule = job.schedule;

    if (schedule.kind === "every") {
      const interval = schedule.every; // ms
      const lastRun = job.state?.lastRunAtMs || 0;

      if (lastRun === 0) {
        // 初回のみ stagger で遅延（以後は純粋な interval）
        const stagger = this._stagger(job.id, schedule.staggerMs || 0);
        return stagger;
      }

      // 2回目以降: 純粋な interval - elapsed（stagger は加算しない）
      const elapsed = Date.now() - lastRun;
      const remaining = interval - elapsed;

      // 遅延がマイナス（実行が遅れている）→ 即実行
      return Math.max(0, remaining);
    }

    if (schedule.kind === "at") {
      const targetMs = new Date(schedule.at).getTime();
      const now = Date.now();
      if (targetMs <= now) {
        // 既に過ぎている → 未実行なら即実行
        if (!job.state?.lastRunAtMs) return 0;
        return null; // 実行済み
      }
      return targetMs - now;
    }

    if (schedule.kind === "cron") {
      logger.warn(MODULE, "cron expressions not yet supported (Phase 2)", {
        id: job.id,
        expr: schedule.expr,
      });
      return null;
    }

    return null;
  }

  /**
   * 決定論的 stagger: hash(jobId) % staggerMs
   * 同じ interval で複数ジョブが走るときに実行時刻をズラす
   */
  _stagger(jobId, staggerMs) {
    if (!staggerMs || staggerMs <= 0) return 0;
    const hash = crypto.createHash("md5").update(jobId).digest();
    const num = hash.readUInt32BE(0);
    return num % staggerMs;
  }

  /**
   * ジョブ実行
   */
  async _runJob(job) {
    if (this._stopped) return;
    if (this.running.has(job.id)) {
      logger.warn(MODULE, "skip: already running", { id: job.id });
      this._scheduleNext(job);
      return;
    }

    this.running.add(job.id);
    const startMs = Date.now();

    logger.info(MODULE, "running", { id: job.id, name: job.name });

    try {
      // 1. セッション解決
      const sessionKey = buildSessionKey({ cronJobId: job.id });
      const session = await this.sessionManager.resolve(sessionKey, job.agentId || "main");

      // 2. Agent 実行
      const payload = job.payload;
      const result = await this.agentRunner.run({
        sessionId: session.sessionId,
        agentId: job.agentId || "main",
        model: payload.model || "sonnet",
        message: payload.message,
        timeoutMs: (payload.timeoutSeconds || 300) * 1000,
        systemPrompt: payload.systemPrompt,
        workspacePath: payload.workspacePath,
        sessionType: "cron",
      });

      // 3. exitCode チェック
      if (result.exitCode !== 0) {
        const detail = result.stderr || result.text.slice(0, 200);
        throw new Error(`agent exited with code ${result.exitCode}: ${detail}`);
      }

      // 4. NO_REPLY 判定
      const output = result.text;
      const isNoReply =
        !output ||
        output === "NO_REPLY" ||
        output.trim() === "" ||
        output.trim().toUpperCase() === "NO_REPLY";

      // 4. Delivery (NO_REPLY でなければ)
      if (!isNoReply && job.delivery) {
        await this.deliveryQueue.enqueue({
          channel: job.delivery.channel,
          to: job.delivery.to,
          payloads: [{ text: output }],
          bestEffort: job.delivery.bestEffort ?? true,
        });
        logger.info(MODULE, "enqueued delivery", { id: job.id, channel: job.delivery.channel });
      } else if (isNoReply) {
        logger.info(MODULE, "NO_REPLY → skip delivery", { id: job.id });
      }

      // 5. State 更新
      const durationMs = Date.now() - startMs;
      await this._updateJobState(job.id, {
        lastRunAtMs: Date.now(),
        lastStatus: "success",
        lastDurationMs: durationMs,
        consecutiveErrors: 0,
        lastOutput: output.slice(0, 500), // 先頭500文字のみ保存
      });

      // 6. deleteAfterRun
      if (job.deleteAfterRun) {
        logger.info(MODULE, "deleteAfterRun → removing", { id: job.id });
        await this.removeJob(job.id);
        return; // scheduleNext 不要
      }
    } catch (err) {
      logger.error(MODULE, "job failed", { id: job.id, err: err.message });

      await this._updateJobState(job.id, {
        lastRunAtMs: Date.now(),
        lastStatus: "error",
        lastDurationMs: Date.now() - startMs,
        lastError: err.message,
        consecutiveErrors: (job.state?.consecutiveErrors || 0) + 1,
      });
    } finally {
      this.running.delete(job.id);

      // 7. 次回スケジュール（deleteAfterRun 以外）
      if (!job.deleteAfterRun) {
        // 最新の state を反映して再スケジュール
        const freshData = await this._loadJobs();
        const freshJob = freshData.jobs.find((j) => j.id === job.id);
        if (freshJob && freshJob.enabled) {
          this._scheduleNext(freshJob);
        }
      }
    }
  }

  /**
   * ジョブの state を更新（atomic write）
   */
  async _updateJobState(jobId, stateUpdates) {
    const lockPath = this.jobsFile + ".lock";
    await withLock(lockPath, async () => {
      const data = await this._loadJobs();
      const job = data.jobs.find((j) => j.id === jobId);
      if (job) {
        job.state = { ...job.state, ...stateUpdates };
        await this._persistJobs(data);
      }
    });
  }

  /**
   * jobs.json 読み込み
   */
  async _loadJobs() {
    const data = await readJSON(this.jobsFile);
    if (!data) {
      return { version: 1, jobs: [] };
    }
    return data;
  }

  /**
   * jobs.json 書き込み（atomic）
   */
  async _persistJobs(data) {
    await atomicWriteJSON(this.jobsFile, data);
    this._jobs = data; // キャッシュ更新
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
