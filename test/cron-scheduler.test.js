/**
 * cron-scheduler.test.js — CronScheduler の単体テスト
 *
 * 検証: every の次回計算、at の1回実行+削除、NO_REPLY判定、state更新、stagger
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { CronScheduler } from "../src/cron-scheduler.js";
import { DeliveryQueue } from "../src/delivery-queue.js";
import { SessionManager } from "../src/session-manager.js";
import { atomicWriteJSON, readJSON, ensureDir } from "../src/utils/storage.js";
import { setLogLevel } from "../src/utils/logger.js";

setLogLevel("error");

let tmpDir;
let jobsFile;
let sessionsDir;
let queueDir;
let deadLetterDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-test-"));
  jobsFile = path.join(tmpDir, "jobs.json");
  sessionsDir = path.join(tmpDir, "sessions");
  queueDir = path.join(tmpDir, "queue");
  deadLetterDir = path.join(tmpDir, "dead-letter");
  await ensureDir(sessionsDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** モック AgentRunner */
function mockAgentRunner(output = "Hello from agent") {
  return {
    sessionsDir,
    async init() {},
    async run() {
      return { text: output, exitCode: 0, mode: "mock" };
    },
  };
}

/** テスト用のジョブデータ作成 */
function makeJob(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    agentId: "main",
    name: "test-job",
    enabled: true,
    schedule: { kind: "every", every: 60000 },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      model: "sonnet",
      message: "test",
      timeoutSeconds: 30,
    },
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "-100123:topic:6",
      bestEffort: true,
    },
    deleteAfterRun: false,
    state: { lastRunAtMs: 0, lastStatus: null, consecutiveErrors: 0 },
    ...overrides,
  };
}

describe("CronScheduler", () => {
  it("every: ジョブがスケジュールされて実行される", async () => {
    const adapter = { name: "telegram", calls: [], async send(to, p) { this.calls.push({ to, p }); } };
    const dq = new DeliveryQueue({ queueDir, deadLetterDir, adapters: { telegram: adapter } });
    await dq.init();
    const sm = new SessionManager({ dataDir: sessionsDir });
    await sm.init();

    const job = makeJob({
      schedule: { kind: "every", every: 100 }, // 100ms
    });

    await atomicWriteJSON(jobsFile, { version: 1, jobs: [job] });

    const cs = new CronScheduler({
      jobsFile,
      agentRunner: mockAgentRunner("Hello!"),
      deliveryQueue: dq,
      sessionManager: sm,
    });

    await cs.start();

    // ジョブ実行を待つ
    await new Promise((r) => setTimeout(r, 300));
    await cs.stop();

    // state が更新されている
    const data = await readJSON(jobsFile);
    const updated = data.jobs[0];
    assert.ok(updated.state.lastRunAtMs > 0);
    assert.equal(updated.state.lastStatus, "success");
    assert.equal(updated.state.consecutiveErrors, 0);

    // delivery queue に enqueue された
    assert.ok(await dq.size() > 0 || adapter.calls.length > 0);
  });

  it("at: 1回実行 + deleteAfterRun で自動削除", async () => {
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: { name: "telegram", async send() {} } },
    });
    await dq.init();
    const sm = new SessionManager({ dataDir: sessionsDir });
    await sm.init();

    const futureMs = Date.now() + 100; // 100ms 後
    const job = makeJob({
      schedule: { kind: "at", at: new Date(futureMs).toISOString() },
      deleteAfterRun: true,
    });

    await atomicWriteJSON(jobsFile, { version: 1, jobs: [job] });

    const cs = new CronScheduler({
      jobsFile,
      agentRunner: mockAgentRunner("one-shot result"),
      deliveryQueue: dq,
      sessionManager: sm,
    });

    await cs.start();
    await new Promise((r) => setTimeout(r, 500));
    await cs.stop();

    // ジョブが削除されている
    const data = await readJSON(jobsFile);
    assert.equal(data.jobs.length, 0);
  });

  it("NO_REPLY: 出力が空 or NO_REPLY → delivery スキップ", async () => {
    const adapter = { name: "telegram", calls: [], async send(to, p) { this.calls.push({ to, p }); } };
    const dq = new DeliveryQueue({ queueDir, deadLetterDir, adapters: { telegram: adapter } });
    await dq.init();
    const sm = new SessionManager({ dataDir: sessionsDir });
    await sm.init();

    const job = makeJob({
      schedule: { kind: "every", every: 50 },
    });

    await atomicWriteJSON(jobsFile, { version: 1, jobs: [job] });

    const cs = new CronScheduler({
      jobsFile,
      agentRunner: mockAgentRunner("NO_REPLY"), // NO_REPLY を返す
      deliveryQueue: dq,
      sessionManager: sm,
    });

    await cs.start();
    await new Promise((r) => setTimeout(r, 200));
    await cs.stop();

    // delivery queue に何も積まれていない
    assert.equal(await dq.size(), 0);
    assert.equal(adapter.calls.length, 0);
  });

  it("stagger: 同一 interval で2ジョブ → 実行時刻にズレ", async () => {
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: { name: "telegram", async send() {} } },
    });
    await dq.init();
    const sm = new SessionManager({ dataDir: sessionsDir });
    await sm.init();

    const job1 = makeJob({
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      name: "job-1",
      schedule: { kind: "every", every: 10000, staggerMs: 5000 },
    });
    const job2 = makeJob({
      id: "bbbbbbbb-2222-2222-2222-222222222222",
      name: "job-2",
      schedule: { kind: "every", every: 10000, staggerMs: 5000 },
    });

    await atomicWriteJSON(jobsFile, { version: 1, jobs: [job1, job2] });

    const cs = new CronScheduler({
      jobsFile,
      agentRunner: mockAgentRunner("stagger test"),
      deliveryQueue: dq,
      sessionManager: sm,
    });

    // stagger 値が異なることを確認（決定論的）
    const s1 = cs._stagger(job1.id, 5000);
    const s2 = cs._stagger(job2.id, 5000);
    assert.notEqual(s1, s2);

    // 0 <= stagger < staggerMs
    assert.ok(s1 >= 0 && s1 < 5000);
    assert.ok(s2 >= 0 && s2 < 5000);

    await cs.stop();
  });

  it("regression: stagger は初回のみ — 2回目以降は純粋な interval", async () => {
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: { name: "telegram", async send() {} } },
    });
    await dq.init();
    const sm = new SessionManager({ dataDir: sessionsDir });
    await sm.init();

    const cs = new CronScheduler({
      jobsFile,
      agentRunner: mockAgentRunner("ok"),
      deliveryQueue: dq,
      sessionManager: sm,
    });

    // stagger=5000, every=10000 の場合
    // 初回: delay = stagger (0〜5000の間)
    // 2回目: delay = interval - elapsed（stagger なし）
    const job = makeJob({
      schedule: { kind: "every", every: 10000, staggerMs: 5000 },
      state: { lastRunAtMs: Date.now() - 10000 }, // 丁度 interval 分前
    });

    const delay = cs._calculateDelay(job);
    // 2回目: interval(10000) - elapsed(10000) = 0（stagger は加算されない）
    assert.ok(delay <= 100, `delay should be ~0, got ${delay}`);
    // stagger を足していた旧実装なら delay > 0 になるはず
    await cs.stop();
  });

  it("regression: exitCode !== 0 → error state に記録", async () => {
    const adapter = { name: "telegram", calls: [], async send(to, p) { this.calls.push({ to, p }); } };
    const dq = new DeliveryQueue({ queueDir, deadLetterDir, adapters: { telegram: adapter } });
    await dq.init();
    const sm = new SessionManager({ dataDir: sessionsDir });
    await sm.init();

    // exitCode=1 を返すモック
    const failRunner = {
      sessionsDir,
      async init() {},
      async run() {
        return { text: "error output", stderr: "something went wrong", exitCode: 1, mode: "mock" };
      },
    };

    const job = makeJob({ schedule: { kind: "every", every: 100 } });
    await atomicWriteJSON(jobsFile, { version: 1, jobs: [job] });

    const cs = new CronScheduler({
      jobsFile,
      agentRunner: failRunner,
      deliveryQueue: dq,
      sessionManager: sm,
    });

    await cs.start();
    await new Promise((r) => setTimeout(r, 300));
    await cs.stop();

    const data = await readJSON(jobsFile);
    const updated = data.jobs[0];
    assert.equal(updated.state.lastStatus, "error");
    assert.ok(updated.state.consecutiveErrors >= 1);
    assert.ok(updated.state.lastError.includes("exited with code 1"));
    // delivery には enqueue されない
    assert.equal(adapter.calls.length, 0);
  });

  it("disabled ジョブはスケジュールされない", async () => {
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: { name: "telegram", async send() {} } },
    });
    await dq.init();
    const sm = new SessionManager({ dataDir: sessionsDir });
    await sm.init();

    const job = makeJob({ enabled: false, schedule: { kind: "every", every: 50 } });
    await atomicWriteJSON(jobsFile, { version: 1, jobs: [job] });

    const cs = new CronScheduler({
      jobsFile,
      agentRunner: mockAgentRunner("should not run"),
      deliveryQueue: dq,
      sessionManager: sm,
    });

    await cs.start();
    await new Promise((r) => setTimeout(r, 200));
    await cs.stop();

    // 実行されていない
    const data = await readJSON(jobsFile);
    assert.equal(data.jobs[0].state.lastRunAtMs, 0);
  });
});
