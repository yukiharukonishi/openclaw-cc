/**
 * telegram.js — Telegram Bot API adapter
 *
 * OpenClaw 互換の Telegram 配信:
 * - "to" フィールドパース: "chatId" or "chatId:topic:threadId"
 * - 4096文字チャンク分割（改行優先）
 * - ACK リアクション (👀) の追加/削除
 */

import * as logger from "../utils/logger.js";

const TELEGRAM_MAX_LENGTH = 4096;
const MODULE = "telegram";

/**
 * Telegram "to" フィールドをパース
 * 形式: "chatId" or "chatId:topic:threadId"
 *
 * @param {string} to - OpenClaw 形式の宛先
 * @returns {{ chatId: string, topicId: number|null }}
 */
export function parseTo(to) {
  const parts = to.split(":");
  const chatId = parts[0];
  let topicId = null;

  // "chatId:topic:123" 形式
  if (parts.length >= 3 && parts[1] === "topic") {
    topicId = parseInt(parts[2], 10);
  }

  return { chatId, topicId };
}

/**
 * テキストを Telegram の最大長に合わせてチャンク分割
 * 改行で分割を優先し、なければ強制分割
 *
 * TODO (Phase 2): コードフェンス (```) の途中で分割しない保護を追加
 *   → 分割候補が ``` ブロック内なら、ブロック終了まで延長する
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
export function chunkText(text, maxLen = TELEGRAM_MAX_LENGTH) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // 改行で分割を試みる（maxLen 以内で最後の改行を探す）
    let splitAt = remaining.lastIndexOf("\n", maxLen);

    // 改行が見つからない or 先頭すぎる場合はスペースで試みる
    if (splitAt <= 0 || splitAt < maxLen * 0.3) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }

    // それでもダメなら強制分割
    if (splitAt <= 0) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, ""); // 先頭改行を除去
  }

  return chunks;
}

/**
 * Telegram Bot API でメッセージ送信
 *
 * @param {string} botToken
 * @param {string} to - OpenClaw 形式 "chatId" or "chatId:topic:threadId"
 * @param {object} payload - { text, mediaUrls }
 * @returns {Promise<object>} Telegram API レスポンス
 */
export async function sendMessage(botToken, to, payload) {
  const { chatId, topicId } = parseTo(to);
  const chunks = chunkText(payload.text);
  const results = [];

  for (const chunk of chunks) {
    const body = {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
    };

    if (topicId != null) {
      body.message_thread_id = topicId;
    }

    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const data = await res.json();

    if (!data.ok) {
      const errMsg = `Telegram send failed: ${data.description || "unknown error"} (chat_id=${chatId}). Input was: "${to}".`;
      throw new Error(errMsg);
    }

    results.push(data.result);
    logger.debug(MODULE, "chunk sent", { chatId, topicId, len: chunk.length });
  }

  return results;
}

/**
 * ACK リアクション (👀) を追加
 */
export async function addAckReaction(botToken, chatId, messageId) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/setMessageReaction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji: "👀" }],
        }),
      }
    );
    return await res.json();
  } catch (err) {
    logger.warn(MODULE, "ACK reaction failed", { err: err.message });
    return null;
  }
}

/**
 * ACK リアクション除去
 */
export async function removeAckReaction(botToken, chatId, messageId) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/setMessageReaction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [],
        }),
      }
    );
    return await res.json();
  } catch (err) {
    logger.warn(MODULE, "Remove ACK reaction failed", { err: err.message });
    return null;
  }
}

/**
 * Adapter インターフェース — DeliveryQueue から呼ばれる
 */
export function createAdapter(botToken) {
  return {
    name: "telegram",

    async send(to, payload) {
      return sendMessage(botToken, to, payload);
    },
  };
}
