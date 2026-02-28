/**
 * agent-runner.test.js — AgentRunner の単体テスト
 *
 * 注意: 実際の claude CLI を呼ぶのではなく、_execClaude をモックして
 * ロジックの正しさを検証する。E2E テストは別途。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentRunner } from "../src/agent-runner.js";
import { readJSONL } from "../src/utils/storage.js";
import { setLogLevel } from "../src/utils/logger.js";

setLogLevel("error");

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-test-"));
  AgentRunner.resetModeCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * AgentRunner のサブクラスでモック
 * _execClaude と _detectMode をオーバーライド
 */
class MockAgentRunner extends AgentRunner {
  constructor(opts) {
    super(opts);
    this.execCalls = [];
    this._mockOutput = opts.mockOutput || "mock response";
    this._mockMode = opts.mockMode || "jsonl";
  }

  async _detectMode() {
    return this._mockMode;
  }

  _execClaude({ args, input }) {
    this.execCalls.push({ args, input });
    return Promise.resolve({
      stdout: this._mockOutput,
      stderr: "",
      exitCode: 0,
    });
  }
}

describe("AgentRunner", () => {
  it("JSONL mode: 履歴なしで実行 → 履歴に追記", async () => {
    const runner = new MockAgentRunner({
      sessionsDir: tmpDir,
      mockOutput: "Agent says hello",
      mockMode: "jsonl",
    });
    await runner.init();

    const result = await runner.run({
      sessionId: "test-session-1",
      agentId: "main",
      model: "sonnet",
      message: "What is 1+1?",
    });

    assert.equal(result.text, "Agent says hello");
    assert.equal(result.exitCode, 0);
    assert.equal(result.mode, "jsonl");

    // JSONL に書き込まれたか
    const history = await readJSONL(path.join(tmpDir, "main", "test-session-1.jsonl"));
    assert.equal(history.length, 2);
    assert.equal(history[0].role, "user");
    assert.equal(history[0].content, "What is 1+1?");
    assert.equal(history[1].role, "assistant");
    assert.equal(history[1].content, "Agent says hello");
  });

  it("JSONL mode: 既存履歴がコンテキストに含まれる", async () => {
    const runner = new MockAgentRunner({
      sessionsDir: tmpDir,
      mockOutput: "followup response",
      mockMode: "jsonl",
    });
    await runner.init();

    // 先に履歴を作成
    await runner.run({
      sessionId: "test-session-2",
      agentId: "main",
      message: "First message",
    });

    // 2回目の実行
    await runner.run({
      sessionId: "test-session-2",
      agentId: "main",
      message: "Second message",
    });

    // 2回目のclaude呼び出しで履歴が含まれている
    const secondCall = runner.execCalls[1];
    assert.ok(secondCall.input.includes("conversation_history"));
    assert.ok(secondCall.input.includes("First message"));
  });

  it("CLI mode: --session-id が args に含まれる", async () => {
    const runner = new MockAgentRunner({
      sessionsDir: tmpDir,
      mockOutput: "cli response",
      mockMode: "cli",
    });
    await runner.init();

    const result = await runner.run({
      sessionId: "cli-session-1",
      agentId: "main",
      model: "opus",
      message: "Test prompt",
    });

    assert.equal(result.mode, "cli");
    assert.equal(result.text, "cli response");

    // args に --session-id が含まれる
    const call = runner.execCalls[0];
    assert.ok(call.args.includes("--session-id"));
    assert.ok(call.args.includes("cli-session-1"));
    assert.ok(call.args.includes("--model"));
    assert.ok(call.args.includes("opus"));
  });

  it("system prompt が指定されると --system-prompt が渡される", async () => {
    const runner = new MockAgentRunner({
      sessionsDir: tmpDir,
      mockOutput: "ok",
      mockMode: "cli",
    });
    await runner.init();

    await runner.run({
      sessionId: "sp-test",
      agentId: "main",
      message: "test",
      systemPrompt: "You are a helpful assistant.",
    });

    const call = runner.execCalls[0];
    assert.ok(call.args.includes("--system-prompt"));
    assert.ok(call.args.includes("You are a helpful assistant."));
  });

  it("JSONL mode: --no-session-persistence が渡される", async () => {
    const runner = new MockAgentRunner({
      sessionsDir: tmpDir,
      mockOutput: "ok",
      mockMode: "jsonl",
    });
    await runner.init();

    await runner.run({
      sessionId: "nsp-test",
      agentId: "main",
      message: "test",
    });

    const call = runner.execCalls[0];
    assert.ok(call.args.includes("--no-session-persistence"));
  });

  it("workspace context が systemPrompt の先頭に注入される", async () => {
    // workspace ディレクトリを tmpDir 内に作成
    const wsDir = path.join(tmpDir, "workspace");
    await fs.mkdir(wsDir, { recursive: true });
    await fs.writeFile(
      path.join(wsDir, "SOUL.md"),
      "# Soul\n\nYou are a helpful agent.",
      "utf-8"
    );

    const runner = new MockAgentRunner({
      sessionsDir: tmpDir,
      mockOutput: "workspace test",
      mockMode: "cli",
    });
    await runner.init();

    await runner.run({
      sessionId: "ws-test",
      agentId: "main",
      message: "hello",
      systemPrompt: "Custom instructions here.",
      workspacePath: wsDir,
      sessionType: "cron", // cron = SOUL のみ → 軽量で確認しやすい
    });

    const call = runner.execCalls[0];
    const spIdx = call.args.indexOf("--system-prompt");
    assert.ok(spIdx !== -1, "--system-prompt arg exists");

    const sp = call.args[spIdx + 1];
    // workspace context が先頭にある
    assert.ok(sp.startsWith("<SOUL>"), "context starts with <SOUL>");
    assert.ok(sp.includes("You are a helpful agent."), "SOUL content injected");
    // 元の systemPrompt が末尾に残っている
    assert.ok(sp.includes("Custom instructions here."), "original systemPrompt preserved");
  });

  it("noSessionPersistence: --no-session-persistence + --allowedTools + --max-budget-usd が渡される", async () => {
    const runner = new MockAgentRunner({
      sessionsDir: tmpDir,
      mockOutput: "stateless response",
      mockMode: "cli", // mode 検出をスキップ（noSessionPersistence が先に処理される）
    });
    await runner.init();

    const result = await runner.run({
      sessionId: "stateless-test",
      agentId: "main",
      model: "haiku",
      message: "こんにちは",
      noSessionPersistence: true,
      allowedTools: "Bash,Read,Write,Edit,Grep,Glob",
      maxBudgetUsd: "0.50",
    });

    assert.equal(result.mode, "stateless");
    assert.equal(result.text, "stateless response");

    const call = runner.execCalls[0];
    assert.ok(call.args.includes("--no-session-persistence"), "has --no-session-persistence");
    assert.ok(call.args.includes("--allowedTools"), "has --allowedTools");
    assert.ok(call.args.includes("Bash,Read,Write,Edit,Grep,Glob"), "has tools list");
    assert.ok(call.args.includes("--max-budget-usd"), "has --max-budget-usd");
    assert.ok(call.args.includes("0.50"), "has budget value");
    assert.ok(call.args.includes("--model"), "has --model");
    assert.ok(call.args.includes("haiku"), "model is haiku");
    // --session-id は含まれない（stateless だから）
    assert.ok(!call.args.includes("--session-id"), "no --session-id");
  });

  it("noSessionPersistence: JSONL 履歴に書き込まない", async () => {
    const runner = new MockAgentRunner({
      sessionsDir: tmpDir,
      mockOutput: "stateless no history",
      mockMode: "jsonl",
    });
    await runner.init();

    await runner.run({
      sessionId: "stateless-nohist",
      agentId: "main",
      message: "test",
      noSessionPersistence: true,
    });

    // JSONL ファイルが作成されていないこと
    const historyFile = path.join(tmpDir, "main", "stateless-nohist.jsonl");
    try {
      await fs.access(historyFile);
      assert.fail("JSONL file should not exist in stateless mode");
    } catch (err) {
      assert.equal(err.code, "ENOENT");
    }
  });

  it("workspacePath 未指定時は systemPrompt がそのまま渡される", async () => {
    const runner = new MockAgentRunner({
      sessionsDir: tmpDir,
      mockOutput: "no ws",
      mockMode: "cli",
    });
    await runner.init();

    await runner.run({
      sessionId: "no-ws-test",
      agentId: "main",
      message: "hello",
      systemPrompt: "Original prompt only.",
    });

    const call = runner.execCalls[0];
    const spIdx = call.args.indexOf("--system-prompt");
    const sp = call.args[spIdx + 1];
    assert.equal(sp, "Original prompt only.");
  });
});
