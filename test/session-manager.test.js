/**
 * session-manager.test.js — SessionManager の単体テスト
 *
 * 検証: 新規作成、既存返却、daily reset、idle reset、JSONL append/load
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "../src/session-manager.js";
import { setLogLevel } from "../src/utils/logger.js";

setLogLevel("error");

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sm-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("SessionManager", () => {
  it("新規セッション作成", async () => {
    const sm = new SessionManager({ dataDir: tmpDir });
    await sm.init();

    const result = await sm.resolve("cron:test-job-1", "main");
    assert.ok(result.sessionId);
    assert.equal(result.isNew, true);

    // UUID 形式チェック
    assert.match(result.sessionId, /^[0-9a-f-]{36}$/);
  });

  it("同じキーで2回目 → 既存セッション返却", async () => {
    const sm = new SessionManager({ dataDir: tmpDir });
    await sm.init();

    const first = await sm.resolve("cron:test-job-1", "main");
    const second = await sm.resolve("cron:test-job-1", "main");

    assert.equal(first.sessionId, second.sessionId);
    assert.equal(second.isNew, false);
  });

  it("異なるキー → 異なるセッション", async () => {
    const sm = new SessionManager({ dataDir: tmpDir });
    await sm.init();

    const a = await sm.resolve("cron:job-a", "main");
    const b = await sm.resolve("cron:job-b", "main");

    assert.notEqual(a.sessionId, b.sessionId);
  });

  it("idle reset: idleMs 経過後は新セッション", async () => {
    const sm = new SessionManager({
      dataDir: tmpDir,
      resetPolicy: { daily: "04:00", idleMs: 100 }, // 100ms でリセット
    });
    await sm.init();

    const first = await sm.resolve("cron:idle-test", "main");

    // idleMs 経過を待つ
    await new Promise((r) => setTimeout(r, 150));

    const second = await sm.resolve("cron:idle-test", "main");
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(second.isNew, true);
  });

  it("JSONL append と load", async () => {
    const sm = new SessionManager({ dataDir: tmpDir });
    await sm.init();

    const { sessionId } = await sm.resolve("cron:msg-test", "main");

    await sm.appendMessage("main", sessionId, {
      role: "user",
      content: "Hello",
    });
    await sm.appendMessage("main", sessionId, {
      role: "assistant",
      content: "Hi there!",
    });

    const messages = await sm.loadMessages("main", sessionId);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "Hello");
    assert.equal(messages[1].role, "assistant");
    assert.ok(messages[0].ts); // タイムスタンプ付き
  });

  it("updateMeta で updatedAt が更新される", async () => {
    const sm = new SessionManager({ dataDir: tmpDir });
    await sm.init();

    await sm.resolve("cron:meta-test", "main");

    await new Promise((r) => setTimeout(r, 10));
    await sm.updateMeta("cron:meta-test", "main", { model: "opus" });

    const sessions = await sm.listSessions("main");
    assert.equal(sessions["cron:meta-test"].model, "opus");
  });

  it("異なる agentId は独立", async () => {
    const sm = new SessionManager({ dataDir: tmpDir });
    await sm.init();

    const a = await sm.resolve("cron:shared-key", "agent-a");
    const b = await sm.resolve("cron:shared-key", "agent-b");

    // 同じキーでも agentId が違えば別セッション
    assert.notEqual(a.sessionId, b.sessionId);
  });

  it("regression: daily reset — 複数日跨ぎでもリセットされる", async () => {
    // 旧実装バグ: 「今日の 04:00」だけ見ていたため、
    // updatedAt=2日前 03:50, now=今日 03:30 → false（間に04:00があるのに見逃す）
    // 新実装: 「updatedAtの次のdaily時刻」を求め、now以前か判定

    const sm = new SessionManager({
      dataDir: tmpDir,
      resetPolicy: {
        daily: "04:00",
        idleMs: 999_999_999, // idle は無効化（daily だけをテスト）
      },
    });
    await sm.init();

    // 1. セッション作成
    const first = await sm.resolve("cron:daily-test", "main");

    // 2. sessions.json の updatedAt を2日前 03:50 に書き換え
    const metaFile = path.join(tmpDir, "main", "sessions.json");
    const raw = JSON.parse(await fs.readFile(metaFile, "utf-8"));
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    twoDaysAgo.setHours(3, 50, 0, 0);
    raw["cron:daily-test"].updatedAt = twoDaysAgo.getTime();
    raw["cron:daily-test"].createdAt = twoDaysAgo.getTime();
    await fs.writeFile(metaFile, JSON.stringify(raw, null, 2), "utf-8");

    // 3. 再度 resolve → リセットされるはず
    const second = await sm.resolve("cron:daily-test", "main");
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(second.isNew, true);
  });
});
