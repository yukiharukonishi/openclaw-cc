/**
 * telegram-poller.test.js — TelegramPoller の単体テスト
 *
 * 検証: Long Polling 受信、allowedChatIds フィルタ、Agent 実行、
 * offset 進行、エラー耐性、processing ガード
 *
 * fetch は DI 注入、AgentRunner/SessionManager はモック。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TelegramPoller } from "../src/channel-receivers/telegram-poller.js";
import { readJSON } from "../src/utils/storage.js";
import { setLogLevel } from "../src/utils/logger.js";

setLogLevel("error");

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "poller-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * テスト用のモック群
 */
function createMocks(overrides = {}) {
  const agentCalls = [];
  const sendCalls = [];
  const sessionCalls = [];
  const fetchCalls = [];

  const mockAgentRunner = {
    run: async (opts) => {
      agentCalls.push(opts);
      return overrides.agentResult || { text: "Mock response", exitCode: 0, mode: "cli" };
    },
  };

  const mockSessionManager = {
    resolve: async (key, agentId) => {
      sessionCalls.push({ key, agentId });
      return { sessionId: "mock-session-uuid", isNew: true };
    },
  };

  const mockSendMessage = async (token, to, payload) => {
    sendCalls.push({ token, to, payload });
    return [{ message_id: 999 }];
  };

  // fetchImpl のデフォルト動作: getMe → getUpdates (空) を返す
  const fetchResponses = overrides.fetchResponses || [];
  let fetchIdx = 0;

  const mockFetch = async (url, opts) => {
    fetchCalls.push({ url, opts });

    // カスタムレスポンスがあれば使う
    if (fetchIdx < fetchResponses.length) {
      const resp = fetchResponses[fetchIdx++];
      return { json: async () => resp };
    }

    // デフォルト: method に応じたレスポンス
    if (url.includes("/getMe")) {
      return { json: async () => ({ ok: true, result: { id: 123, username: "test_bot", first_name: "TestBot" } }) };
    }
    if (url.includes("/getUpdates")) {
      return { json: async () => ({ ok: true, result: [] }) };
    }
    if (url.includes("/sendChatAction")) {
      return { json: async () => ({ ok: true, result: true }) };
    }
    return { json: async () => ({ ok: true, result: {} }) };
  };

  return {
    agentCalls,
    sendCalls,
    sessionCalls,
    fetchCalls,
    mockAgentRunner,
    mockSessionManager,
    mockSendMessage,
    mockFetch,
  };
}

function createPoller(mocks, overrides = {}) {
  return new TelegramPoller({
    botToken: "test-token",
    allowedChatIds: overrides.allowedChatIds || ["-100123"],
    agentRunner: mocks.mockAgentRunner,
    sessionManager: mocks.mockSessionManager,
    sendMessage: overrides.sendMessage || mocks.mockSendMessage,
    stateDir: tmpDir,
    pollingIntervalMs: 60_000, // テスト中は自動 polling しない
    agentConfig: overrides.agentConfig || { model: "haiku" },
    fetchImpl: mocks.mockFetch,
  });
}

describe("TelegramPoller", () => {
  it("正常受信 → Agent 実行 → 応答送信", async () => {
    const mocks = createMocks({
      fetchResponses: [
        // getMe
        { ok: true, result: { id: 123, username: "test_bot" } },
        // getUpdates — 1メッセージ
        {
          ok: true,
          result: [
            {
              update_id: 100,
              message: {
                message_id: 1,
                chat: { id: -100123, type: "supergroup" },
                from: { first_name: "TestUser", is_bot: false },
                text: "Hello bot",
              },
            },
          ],
        },
      ],
    });

    const poller = createPoller(mocks);
    await poller.start();
    // start() で getMe + 最初の pollOnce() が実行される
    // pollOnce が非同期で走るので少し待つ
    await new Promise((r) => setTimeout(r, 100));
    await poller.stop();

    // Agent が呼ばれた
    assert.equal(mocks.agentCalls.length, 1);
    assert.ok(mocks.agentCalls[0].message.includes("TestUser"));
    assert.ok(mocks.agentCalls[0].message.includes("Hello bot"));
    assert.equal(mocks.agentCalls[0].sessionType, "group");

    // 応答が送信された
    assert.equal(mocks.sendCalls.length, 1);
    assert.equal(mocks.sendCalls[0].payload.text, "Mock response");

    // セッションが解決された
    assert.equal(mocks.sessionCalls.length, 1);
    assert.ok(mocks.sessionCalls[0].key.includes("telegram"));
    assert.ok(mocks.sessionCalls[0].key.includes("group"));
  });

  it("offset が正しく進行する", async () => {
    const mocks = createMocks({
      fetchResponses: [
        { ok: true, result: { id: 123, username: "test_bot" } },
        {
          ok: true,
          result: [
            {
              update_id: 200,
              message: {
                message_id: 1,
                chat: { id: -100123, type: "supergroup" },
                from: { first_name: "A", is_bot: false },
                text: "msg1",
              },
            },
            {
              update_id: 201,
              message: {
                message_id: 2,
                chat: { id: -100123, type: "supergroup" },
                from: { first_name: "B", is_bot: false },
                text: "msg2",
              },
            },
          ],
        },
      ],
    });

    const poller = createPoller(mocks);
    await poller.start();
    await new Promise((r) => setTimeout(r, 200));
    await poller.stop();

    assert.equal(poller.offset, 201);
    assert.equal(mocks.agentCalls.length, 2);

    // state ファイルに offset が保存されている
    const state = await readJSON(path.join(tmpDir, "poller-state.json"));
    assert.equal(state.offset, 201);
  });

  it("Bot 自身のメッセージは無視される", async () => {
    const mocks = createMocks({
      fetchResponses: [
        { ok: true, result: { id: 123, username: "test_bot" } },
        {
          ok: true,
          result: [
            {
              update_id: 300,
              message: {
                message_id: 1,
                chat: { id: -100123, type: "supergroup" },
                from: { first_name: "Bot", is_bot: true },
                text: "I am a bot",
              },
            },
          ],
        },
      ],
    });

    const poller = createPoller(mocks);
    await poller.start();
    await new Promise((r) => setTimeout(r, 100));
    await poller.stop();

    assert.equal(mocks.agentCalls.length, 0);
    assert.equal(mocks.sendCalls.length, 0);
  });

  it("allowedChatIds にないチャットは無視される", async () => {
    const mocks = createMocks({
      fetchResponses: [
        { ok: true, result: { id: 123, username: "test_bot" } },
        {
          ok: true,
          result: [
            {
              update_id: 400,
              message: {
                message_id: 1,
                chat: { id: -999999, type: "supergroup" },
                from: { first_name: "Stranger", is_bot: false },
                text: "Hi",
              },
            },
          ],
        },
      ],
    });

    const poller = createPoller(mocks, { allowedChatIds: ["-100123"] });
    await poller.start();
    await new Promise((r) => setTimeout(r, 100));
    await poller.stop();

    assert.equal(mocks.agentCalls.length, 0);
  });

  it("topic フィルタ: 指定 topic のみ応答", async () => {
    const mocks = createMocks({
      fetchResponses: [
        { ok: true, result: { id: 123, username: "test_bot" } },
        {
          ok: true,
          result: [
            {
              update_id: 500,
              message: {
                message_id: 1,
                chat: { id: -100123, type: "supergroup" },
                from: { first_name: "User", is_bot: false },
                text: "topic 6 msg",
                message_thread_id: 6,
              },
            },
            {
              update_id: 501,
              message: {
                message_id: 2,
                chat: { id: -100123, type: "supergroup" },
                from: { first_name: "User", is_bot: false },
                text: "topic 99 msg",
                message_thread_id: 99,
              },
            },
          ],
        },
      ],
    });

    // topic:6 のみ許可
    const poller = createPoller(mocks, { allowedChatIds: ["-100123:topic:6"] });
    await poller.start();
    await new Promise((r) => setTimeout(r, 200));
    await poller.stop();

    // topic 6 のみ Agent が呼ばれる
    assert.equal(mocks.agentCalls.length, 1);
    assert.ok(mocks.agentCalls[0].message.includes("topic 6 msg"));

    // 応答の to が topic 付き
    assert.equal(mocks.sendCalls.length, 1);
    assert.equal(mocks.sendCalls[0].to, "-100123:topic:6");
  });

  it("Agent エラー時も polling が継続する", async () => {
    const agentCallCount = { n: 0 };
    const mocks = createMocks();
    mocks.mockAgentRunner.run = async () => {
      agentCallCount.n++;
      throw new Error("Agent crashed");
    };

    // fetchResponses を上書き
    let fetchCallN = 0;
    mocks.mockFetch = async (url) => {
      fetchCallN++;
      if (url.includes("/getMe")) {
        return { json: async () => ({ ok: true, result: { id: 123, username: "test_bot" } }) };
      }
      if (url.includes("/getUpdates")) {
        // 最初の poll のみメッセージを返す
        if (fetchCallN <= 2) {
          return {
            json: async () => ({
              ok: true,
              result: [
                {
                  update_id: 600,
                  message: {
                    message_id: 1,
                    chat: { id: -100123, type: "supergroup" },
                    from: { first_name: "User", is_bot: false },
                    text: "trigger error",
                  },
                },
              ],
            }),
          };
        }
        return { json: async () => ({ ok: true, result: [] }) };
      }
      return { json: async () => ({ ok: true, result: true }) };
    };

    const poller = createPoller(mocks);
    poller._fetch = mocks.mockFetch; // 上書き
    await poller.start();
    await new Promise((r) => setTimeout(r, 100));

    // processing がリセットされている（次の poll が可能）
    assert.equal(poller.processing, false);
    await poller.stop();
  });

  it("sendMessage エラー時も polling が継続する", async () => {
    const mocks = createMocks({
      fetchResponses: [
        { ok: true, result: { id: 123, username: "test_bot" } },
        {
          ok: true,
          result: [
            {
              update_id: 700,
              message: {
                message_id: 1,
                chat: { id: -100123, type: "supergroup" },
                from: { first_name: "User", is_bot: false },
                text: "hello",
              },
            },
          ],
        },
      ],
    });

    const failingSend = async () => {
      throw new Error("Send failed");
    };

    const poller = createPoller(mocks, { sendMessage: failingSend });
    await poller.start();
    await new Promise((r) => setTimeout(r, 100));
    await poller.stop();

    // Agent は呼ばれたが送信が失敗した → polling 継続
    assert.equal(mocks.agentCalls.length, 1);
    assert.equal(poller.processing, false);
  });

  it("state 永続化: stop() 後に offset が保存される", async () => {
    const mocks = createMocks({
      fetchResponses: [
        { ok: true, result: { id: 123, username: "test_bot" } },
        {
          ok: true,
          result: [
            {
              update_id: 800,
              message: {
                message_id: 1,
                chat: { id: -100123, type: "supergroup" },
                from: { first_name: "User", is_bot: false },
                text: "test",
              },
            },
          ],
        },
      ],
    });

    const poller = createPoller(mocks);
    await poller.start();
    await new Promise((r) => setTimeout(r, 100));
    await poller.stop();

    const state = await readJSON(path.join(tmpDir, "poller-state.json"));
    assert.equal(state.offset, 800);
    assert.ok(state.updatedAt);
  });

  it("processing ガード: 処理中は pollOnce() がスキップされる", async () => {
    const mocks = createMocks({
      fetchResponses: [
        { ok: true, result: { id: 123, username: "test_bot" } },
        { ok: true, result: [] },
      ],
    });

    const poller = createPoller(mocks);
    await poller.start();
    await new Promise((r) => setTimeout(r, 50));

    // processing を手動でセット
    poller.processing = true;
    await poller.pollOnce(); // これはスキップされるはず

    poller.processing = false;
    await poller.stop();

    // getMe + 1回の getUpdates のみ（2回目の pollOnce は skip）
    const getUpdatesCalls = mocks.fetchCalls.filter((c) => c.url.includes("getUpdates"));
    assert.equal(getUpdatesCalls.length, 1);
  });

  it("DM (private chat) では sessionType が main になる", async () => {
    const mocks = createMocks({
      fetchResponses: [
        { ok: true, result: { id: 123, username: "test_bot" } },
        {
          ok: true,
          result: [
            {
              update_id: 900,
              message: {
                message_id: 1,
                chat: { id: 456789, type: "private" },
                from: { first_name: "PrivateUser", is_bot: false },
                text: "DM message",
              },
            },
          ],
        },
      ],
    });

    const poller = createPoller(mocks, { allowedChatIds: ["456789"] });
    await poller.start();
    await new Promise((r) => setTimeout(r, 100));
    await poller.stop();

    assert.equal(mocks.agentCalls.length, 1);
    assert.equal(mocks.agentCalls[0].sessionType, "main");

    // session key が dm を含む
    assert.ok(mocks.sessionCalls[0].key.includes("dm"));
  });
});
