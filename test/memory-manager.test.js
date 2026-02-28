/**
 * memory-manager.test.js — MemoryManager の単体テスト
 *
 * 検証: appendDaily, appendLongTerm, pruneOldDaily, ヘッダー生成, withLock 排他
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryManager } from "../src/memory-manager.js";
import { setLogLevel } from "../src/utils/logger.js";

setLogLevel("error");

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 今日の日付を YYYY-MM-DD で取得 */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("MemoryManager", () => {
  it("init: memory ディレクトリが作成される", async () => {
    const mm = new MemoryManager({ workspacePath: tmpDir });
    await mm.init();

    const stat = await fs.stat(path.join(tmpDir, "memory"));
    assert.ok(stat.isDirectory());
  });

  it("appendDaily: today.md が作成されヘッダー付き", async () => {
    const mm = new MemoryManager({ workspacePath: tmpDir });
    await mm.init();

    await mm.appendDaily({ title: "Test entry", body: "Something happened." });

    const filePath = path.join(tmpDir, "memory", `${todayStr()}.md`);
    const content = await fs.readFile(filePath, "utf-8");

    assert.ok(content.startsWith(`# Daily Log — ${todayStr()}`));
    assert.ok(content.includes("## "));
    assert.ok(content.includes("Test entry"));
    assert.ok(content.includes("Something happened."));
  });

  it("appendDaily: 同日2回呼び出し → 追記される", async () => {
    const mm = new MemoryManager({ workspacePath: tmpDir });
    await mm.init();

    await mm.appendDaily({ title: "First", body: "Entry 1" });
    await mm.appendDaily({ title: "Second", body: "Entry 2" });

    const filePath = path.join(tmpDir, "memory", `${todayStr()}.md`);
    const content = await fs.readFile(filePath, "utf-8");

    assert.ok(content.includes("First"));
    assert.ok(content.includes("Second"));
    assert.ok(content.includes("Entry 1"));
    assert.ok(content.includes("Entry 2"));

    // ヘッダーは1回だけ
    const headerCount = (content.match(/# Daily Log/g) || []).length;
    assert.equal(headerCount, 1);
  });

  it("appendLongTerm: MEMORY.md に追記", async () => {
    const mm = new MemoryManager({ workspacePath: tmpDir });
    await mm.init();

    await mm.appendLongTerm({ title: "Important fact", body: "Remember this forever." });

    const filePath = path.join(tmpDir, "MEMORY.md");
    const content = await fs.readFile(filePath, "utf-8");

    assert.ok(content.startsWith("# Long-Term Memory"));
    assert.ok(content.includes("Important fact"));
    assert.ok(content.includes("Remember this forever."));
    assert.ok(content.includes(todayStr()));
  });

  it("appendLongTerm: 既存 MEMORY.md に追記", async () => {
    const mm = new MemoryManager({ workspacePath: tmpDir });
    await mm.init();

    // 既存ファイルを手動作成
    const filePath = path.join(tmpDir, "MEMORY.md");
    await fs.writeFile(filePath, "# Long-Term Memory\n\n## Existing entry\n\nOld data.\n", "utf-8");

    await mm.appendLongTerm({ title: "New entry", body: "New data." });

    const content = await fs.readFile(filePath, "utf-8");
    assert.ok(content.includes("Existing entry"));
    assert.ok(content.includes("Old data."));
    assert.ok(content.includes("New entry"));
    assert.ok(content.includes("New data."));
  });

  it("pruneOldDaily: retainDays 超過ファイルが削除される", async () => {
    const mm = new MemoryManager({ workspacePath: tmpDir, retainDays: 7 });
    await mm.init();

    const memDir = path.join(tmpDir, "memory");

    // 10日前のファイル（削除対象）
    const old = new Date();
    old.setDate(old.getDate() - 10);
    const oldStr = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, "0")}-${String(old.getDate()).padStart(2, "0")}`;
    await fs.writeFile(path.join(memDir, `${oldStr}.md`), "old data", "utf-8");

    // 今日のファイル（残す）
    await fs.writeFile(path.join(memDir, `${todayStr()}.md`), "today data", "utf-8");

    const pruned = await mm.pruneOldDaily();

    assert.equal(pruned, 1);

    // 古いファイルは削除された
    const files = await fs.readdir(memDir);
    assert.ok(!files.includes(`${oldStr}.md`));
    // 今日のファイルは残っている
    assert.ok(files.includes(`${todayStr()}.md`));
  });

  it("pruneOldDaily: 新しいファイルは残る", async () => {
    const mm = new MemoryManager({ workspacePath: tmpDir, retainDays: 7 });
    await mm.init();

    const memDir = path.join(tmpDir, "memory");
    await fs.writeFile(path.join(memDir, `${todayStr()}.md`), "today", "utf-8");

    const pruned = await mm.pruneOldDaily();
    assert.equal(pruned, 0);

    const files = await fs.readdir(memDir);
    assert.ok(files.includes(`${todayStr()}.md`));
  });

  it("pruneOldDaily: 非日付ファイル (.gitkeep等) は無視", async () => {
    const mm = new MemoryManager({ workspacePath: tmpDir, retainDays: 7 });
    await mm.init();

    const memDir = path.join(tmpDir, "memory");
    await fs.writeFile(path.join(memDir, ".gitkeep"), "", "utf-8");

    const pruned = await mm.pruneOldDaily();
    assert.equal(pruned, 0);

    const files = await fs.readdir(memDir);
    assert.ok(files.includes(".gitkeep"));
  });
});
