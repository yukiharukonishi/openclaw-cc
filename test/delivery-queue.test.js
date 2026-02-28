/**
 * delivery-queue.test.js — DeliveryQueue の単体テスト
 *
 * 検証: enqueue, processAll, retry, bestEffort部分成功, TTL, dead-letter, 冪等性
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DeliveryQueue } from "../src/delivery-queue.js";
import { setLogLevel } from "../src/utils/logger.js";

// テスト中はログを抑制
setLogLevel("error");

let tmpDir;
let queueDir;
let deadLetterDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dq-test-"));
  queueDir = path.join(tmpDir, "queue");
  deadLetterDir = path.join(tmpDir, "dead-letter");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** モック adapter: 成功 */
function mockAdapter() {
  const calls = [];
  return {
    calls,
    name: "mock",
    async send(to, payload) {
      calls.push({ to, payload });
    },
  };
}

/** モック adapter: 常に失敗 */
function failAdapter(errMsg = "send failed") {
  return {
    name: "mock",
    async send() {
      throw new Error(errMsg);
    },
  };
}

describe("DeliveryQueue", () => {
  it("enqueue → processAll → 送信確認", async () => {
    const adapter = mockAdapter();
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: adapter },
    });
    await dq.init();

    const id = await dq.enqueue({
      channel: "telegram",
      to: "-100123:topic:6",
      payloads: [{ text: "hello" }],
    });

    assert.ok(id);
    assert.equal(await dq.size(), 1);

    const stats = await dq.processAll();
    assert.equal(stats.succeeded, 1);
    assert.equal(stats.failed, 0);
    assert.equal(await dq.size(), 0);

    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].to, "-100123:topic:6");
    assert.equal(adapter.calls[0].payload.text, "hello");
  });

  it("retry: 失敗後に retryCount が増加", async () => {
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: failAdapter() },
    });
    await dq.init();

    await dq.enqueue({
      channel: "telegram",
      to: "-100123",
      payloads: [{ text: "test" }],
      bestEffort: false,
    });

    // 1回目: 失敗 → retryCount=1
    await dq.processAll();
    assert.equal(await dq.size(), 1);

    // 2回目: 失敗 → retryCount=2
    await dq.processAll();
    assert.equal(await dq.size(), 1);

    // 3回目: 失敗 → retryCount=3
    await dq.processAll();
    assert.equal(await dq.size(), 1);

    // 4回目: retryCount=3 >= maxRetries=3 → dead-letter
    await dq.processAll();
    assert.equal(await dq.size(), 0);
    assert.equal(await dq.deadLetterSize(), 1);
  });

  it("bestEffort: 部分成功 — 成功分削除、失敗分残留", async () => {
    let callCount = 0;
    const partialAdapter = {
      name: "mock",
      async send(_to, payload) {
        callCount++;
        // 2番目の payload だけ失敗
        if (payload.text === "fail-me") {
          throw new Error("forced failure");
        }
      },
    };

    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: partialAdapter },
    });
    await dq.init();

    await dq.enqueue({
      channel: "telegram",
      to: "-100123",
      payloads: [
        { text: "success-1" },
        { text: "fail-me" },
        { text: "success-2" },
      ],
      bestEffort: true,
    });

    const stats = await dq.processAll();
    // 部分成功 → retry 扱い
    assert.equal(stats.processed, 1);
    assert.equal(await dq.size(), 1);

    // 残っているアイテムは失敗分だけ
    const files = await fs.readdir(queueDir);
    const remaining = JSON.parse(
      await fs.readFile(path.join(queueDir, files.filter((f) => f.endsWith(".json"))[0]), "utf-8")
    );
    assert.equal(remaining.payloads.length, 1);
    assert.equal(remaining.payloads[0].text, "fail-me");
    assert.equal(remaining.retryCount, 1);
  });

  it("TTL 超過 → dead-letter", async () => {
    const adapter = mockAdapter();
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: adapter },
      ttlMs: 1, // 1ms TTL
    });
    await dq.init();

    await dq.enqueue({
      channel: "telegram",
      to: "-100123",
      payloads: [{ text: "expired" }],
    });

    // TTL 確実に超過させる
    await new Promise((r) => setTimeout(r, 10));

    const stats = await dq.processAll();
    assert.equal(stats.deadLettered, 1);
    assert.equal(await dq.size(), 0);
    assert.equal(await dq.deadLetterSize(), 1);
    assert.equal(adapter.calls.length, 0);
  });

  it("adapter なし → dead-letter", async () => {
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: {}, // no adapters
    });
    await dq.init();

    await dq.enqueue({
      channel: "telegram",
      to: "-100123",
      payloads: [{ text: "no adapter" }],
    });

    const stats = await dq.processAll();
    assert.equal(stats.deadLettered, 1);
  });

  it("冪等性: .processing フラグで二重処理防止", async () => {
    const adapter = mockAdapter();
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: adapter },
    });
    await dq.init();

    const id = await dq.enqueue({
      channel: "telegram",
      to: "-100123",
      payloads: [{ text: "test" }],
    });

    // .processing フラグを手動で作成（別プロセスが処理中をシミュレート）
    const processingFlag = path.join(queueDir, `${id}.json.processing`);
    await fs.writeFile(processingFlag, "12345");

    const stats = await dq.processAll();
    assert.equal(stats.processed, 0); // スキップされる
    assert.equal(adapter.calls.length, 0);

    // フラグ除去後は処理される
    await fs.unlink(processingFlag);
    const stats2 = await dq.processAll();
    assert.equal(stats2.succeeded, 1);
  });

  it("regression: .processing stale — 古いフラグは解放されて再取得される", async () => {
    // 旧実装バグ: fileExists() → writeFile() の TOCTOU レース
    // 新実装: O_EXCL (wx) で原子的取得 + stale 判定で古い .processing を解放

    const adapter = mockAdapter();
    const dq = new DeliveryQueue({
      queueDir,
      deadLetterDir,
      adapters: { telegram: adapter },
      processingStaleMs: 100, // 100ms で stale 判定
    });
    await dq.init();

    const id = await dq.enqueue({
      channel: "telegram",
      to: "-100123",
      payloads: [{ text: "stale-test" }],
    });

    // stale な .processing フラグを作成（古い mtime を持たせる）
    const processingFlag = path.join(queueDir, `${id}.json.processing`);
    await fs.writeFile(processingFlag, "99999");

    // processingStaleMs 超過を待つ
    await new Promise((r) => setTimeout(r, 150));

    // stale なので解放 → 再取得 → 処理される
    const stats = await dq.processAll();
    assert.equal(stats.succeeded, 1);
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].payload.text, "stale-test");
  });
});
