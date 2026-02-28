/**
 * logger.js — JSON structured logging
 *
 * 全モジュール共通のログ出力。
 * { ts, level, module, msg, ...extra } 形式で stdout に出力。
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS.info;

/**
 * ログレベル設定
 */
export function setLogLevel(level) {
  if (level in LEVELS) {
    minLevel = LEVELS[level];
  }
}

/**
 * 構造化ログ出力
 */
function log(level, module, msg, extra = {}) {
  if (LEVELS[level] < minLevel) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    module,
    msg,
    ...extra,
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const debug = (module, msg, extra) => log("debug", module, msg, extra);
export const info = (module, msg, extra) => log("info", module, msg, extra);
export const warn = (module, msg, extra) => log("warn", module, msg, extra);
export const error = (module, msg, extra) => log("error", module, msg, extra);
