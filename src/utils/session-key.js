/**
 * session-key.js — OpenClaw 互換セッションキー生成
 *
 * OpenClaw のセッションキー形式:
 * - cron ジョブ: "cron:{jobId}"
 * - DM: "agent:{agentId}:{channel}:dm:{peerId}"
 * - グループ: "agent:{agentId}:{channel}:group:{peerId}"
 * - トピック付き: "agent:{agentId}:{channel}:group:{peerId}:topic:{topicId}"
 */

/**
 * セッションキーを構築
 *
 * @param {object} opts
 * @param {string} [opts.cronJobId] - Cron ジョブID（指定時は他を無視）
 * @param {string} [opts.agentId] - エージェントID
 * @param {string} [opts.channel] - チャネル名 (telegram, slack, etc.)
 * @param {string} [opts.peerKind] - "dm" | "group"
 * @param {string} [opts.peerId] - ピアID
 * @param {string|number} [opts.topicId] - トピックID（オプション）
 * @returns {string} セッションキー
 */
export function buildSessionKey({ cronJobId, agentId, channel, peerKind, peerId, topicId }) {
  // Cron ジョブは専用キー
  if (cronJobId) {
    return `cron:${cronJobId}`;
  }

  if (!agentId || !channel) {
    throw new Error("agentId and channel are required for non-cron session keys");
  }

  let key = `agent:${agentId}:${channel}`;

  if (peerKind === "dm") {
    key += `:dm:${peerId}`;
  } else if (peerKind === "group") {
    key += `:group:${peerId}`;
  }

  if (topicId != null) {
    key += `:topic:${topicId}`;
  }

  return key;
}

/**
 * セッションキーをパース（逆変換）
 *
 * @param {string} key
 * @returns {object} パース結果
 */
export function parseSessionKey(key) {
  const parts = key.split(":");

  if (parts[0] === "cron") {
    return { type: "cron", cronJobId: parts.slice(1).join(":") };
  }

  if (parts[0] === "agent") {
    const result = {
      type: "agent",
      agentId: parts[1],
      channel: parts[2],
    };

    let i = 3;
    if (parts[i] === "dm" || parts[i] === "group") {
      result.peerKind = parts[i];
      result.peerId = parts[i + 1];
      i += 2;
    }

    if (parts[i] === "topic") {
      result.topicId = parts[i + 1];
    }

    return result;
  }

  return { type: "unknown", raw: key };
}
