/**
 * telegram-poller.js — Telegram Long Polling receiver
 *
 * OpenClaw 互換の Telegram メッセージ受信:
 * - getUpdates による Long Polling（Gateway 不要）
 * - 受信 → AgentRunner 実行 → 直接 sendMessage で応答
 * - allowedChatIds ホワイトリストでアクセス制御
 * - offset を atomic write で永続化（crash 復帰対応）
 *
 * リファレンス: telegram-bridge.js パターン
 */

import path from "node:path";
import * as logger from "../utils/logger.js";
import { atomicWriteJSON, readJSON, ensureDir } from "../utils/storage.js";
import { buildSessionKey } from "../utils/session-key.js";

const MODULE = "telegram-poller";

export class TelegramPoller {
  /**
   * @param {object} opts
   * @param {string} opts.botToken - Telegram Bot Token
   * @param {string[]} opts.allowedChatIds - 許可するチャット ("chatId" or "chatId:topic:N")
   * @param {object} opts.agentRunner - AgentRunner インスタンス
   * @param {object} opts.sessionManager - SessionManager インスタンス
   * @param {Function} opts.sendMessage - channel-adapters/telegram.js の sendMessage
   * @param {string} opts.stateDir - offset 保存先ディレクトリ
   * @param {number} [opts.pollingIntervalMs=3000]
   * @param {object} [opts.agentConfig] - { model, timeoutMs, workspacePath, systemPrompt }
   * @param {Function} [opts.fetchImpl] - テスト用 fetch 注入
   */
  constructor({
    botToken,
    allowedChatIds = [],
    agentRunner,
    sessionManager,
    sendMessage,
    stateDir,
    pollingIntervalMs = 3000,
    agentConfig = {},
    fetchImpl,
  }) {
    this.botToken = botToken;
    this.allowedChatIds = allowedChatIds;
    this.agentRunner = agentRunner;
    this.sessionManager = sessionManager;
    this.sendMessage = sendMessage;
    this.stateDir = stateDir;
    this.pollingIntervalMs = pollingIntervalMs;
    this.agentConfig = agentConfig;
    this._fetch = fetchImpl || globalThis.fetch;

    this.offset = 0;
    this.processing = false;
    this._interval = null;
    this._statePath = path.join(stateDir, "poller-state.json");
    this._botInfo = null;

    // allowedChatIds をパースしてルックアップ用に展開
    this._allowedRules = this._parseAllowedChatIds(allowedChatIds);
  }

  /**
   * Poller 起動: getMe で接続確認 → polling 開始
   */
  async start() {
    await ensureDir(this.stateDir);
    await this._loadState();

    // Bot 接続確認
    this._botInfo = await this._telegramApi("getMe");
    logger.info(MODULE, "bot connected", {
      username: this._botInfo.username,
      id: this._botInfo.id,
    });

    // Polling 開始
    this._interval = setInterval(() => this.pollOnce(), this.pollingIntervalMs);
    this.pollOnce(); // 即座に1回目
    logger.info(MODULE, "polling started", {
      intervalMs: this.pollingIntervalMs,
      allowedChats: this.allowedChatIds.length,
    });
  }

  /**
   * Poller 停止: interval クリア + state 保存
   */
  async stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    await this._saveState();
    logger.info(MODULE, "polling stopped", { offset: this.offset });
  }

  /**
   * 1回の polling サイクル（テスト可能な単位）
   */
  async pollOnce() {
    if (this.processing) return;
    this.processing = true;

    try {
      const updates = await this._telegramApi("getUpdates", {
        offset: this.offset + 1,
        timeout: 30,
        allowed_updates: ["message"],
      });

      if (updates && updates.length > 0) {
        logger.info(MODULE, `received ${updates.length} updates`);
        for (const update of updates) {
          this.offset = update.update_id;
          try {
            await this._handleMessage(update);
          } catch (err) {
            logger.error(MODULE, "handle error", { err: err.message });
          }
        }
        await this._saveState();
      }
    } catch (err) {
      logger.error(MODULE, "poll error", { err: err.message });
    } finally {
      this.processing = false;
    }
  }

  /**
   * メッセージ処理: フィルタ → Agent 実行 → 応答
   */
  async _handleMessage(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;
    const topicId = msg.message_thread_id || null;
    const text = msg.text;
    const fromUser = msg.from?.first_name || "User";
    const chatType = msg.chat.type; // "private", "group", "supergroup"

    // Bot 自身のメッセージは無視
    if (msg.from?.is_bot) return;

    // allowedChatIds フィルタ
    if (!this._isAllowed(chatId, topicId)) {
      logger.debug(MODULE, "chat not allowed, skipping", { chatId, topicId });
      return;
    }

    logger.info(MODULE, "message received", {
      from: fromUser,
      chatId,
      topicId,
      text: text.substring(0, 50),
    });

    // Typing indicator
    try {
      const typingBody = { chat_id: chatId, action: "typing" };
      if (topicId) typingBody.message_thread_id = topicId;
      await this._telegramApi("sendChatAction", typingBody);
    } catch {
      // typing 失敗は無視
    }

    // セッション解決
    const peerKind = chatType === "private" ? "dm" : "group";
    const sessionKey = buildSessionKey({
      agentId: "main",
      channel: "telegram",
      peerKind,
      peerId: String(chatId),
      topicId,
    });

    const session = await this.sessionManager.resolve(sessionKey, "main");

    // Agent 実行（stateless — telegram-bridge.js 互換）
    const sessionType = chatType === "private" ? "main" : "group";
    const result = await this.agentRunner.run({
      sessionId: session.sessionId,
      agentId: "main",
      model: this.agentConfig.model || "sonnet",
      message: `[Telegram] ${fromUser}: ${text}`,
      timeoutMs: this.agentConfig.timeoutMs || 120_000,
      systemPrompt: this.agentConfig.systemPrompt,
      workspacePath: this.agentConfig.workspacePath,
      sessionType,
      noSessionPersistence: true,
      allowedTools: this.agentConfig.allowedTools,
      maxBudgetUsd: this.agentConfig.maxBudgetUsd,
    });

    // 応答送信（直接 sendMessage、DeliveryQueue は使わない）
    const responseText = result.text || "[No response]";
    const to = topicId
      ? `${chatId}:topic:${topicId}`
      : String(chatId);

    try {
      await this.sendMessage(this.botToken, to, { text: responseText });
      logger.info(MODULE, "reply sent", { chatId, topicId, len: responseText.length });
    } catch (err) {
      logger.error(MODULE, "reply failed", { chatId, err: err.message });
    }
  }

  /**
   * allowedChatIds ホワイトリスト判定
   */
  _isAllowed(chatId, topicId) {
    if (this._allowedRules.length === 0) return false;

    const chatStr = String(chatId);

    for (const rule of this._allowedRules) {
      if (rule.chatId === chatStr) {
        // topic 制限がなければ全 topic 許可
        if (rule.topicId === null) return true;
        // topic 指定がある場合は一致のみ許可
        if (topicId != null && rule.topicId === topicId) return true;
      }
    }

    return false;
  }

  /**
   * allowedChatIds 文字列をパース
   * "-1001234567890" → { chatId: "-1001234567890", topicId: null }
   * "-1001234567890:topic:6" → { chatId: "-1001234567890", topicId: 6 }
   */
  _parseAllowedChatIds(ids) {
    return ids.map((id) => {
      const parts = id.split(":");
      if (parts.length >= 3 && parts[1] === "topic") {
        return { chatId: parts[0], topicId: parseInt(parts[2], 10) };
      }
      return { chatId: parts[0], topicId: null };
    });
  }

  /**
   * Telegram Bot API 呼び出し
   */
  async _telegramApi(method, body) {
    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const opts = {
      method: body ? "POST" : "GET",
    };
    if (body) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }

    const res = await this._fetch(url, opts);
    const data = await res.json();

    if (!data.ok) {
      throw new Error(`Telegram API ${method}: ${data.description || "unknown error"}`);
    }

    return data.result;
  }

  /**
   * offset 読み込み
   */
  async _loadState() {
    const state = await readJSON(this._statePath);
    if (state && typeof state.offset === "number") {
      this.offset = state.offset;
      logger.info(MODULE, "state loaded", { offset: this.offset });
    }
  }

  /**
   * offset 保存（atomic write）
   */
  async _saveState() {
    await atomicWriteJSON(this._statePath, {
      offset: this.offset,
      updatedAt: new Date().toISOString(),
    });
  }
}
