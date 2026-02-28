/**
 * workspace-loader.test.js — WorkspaceLoader の単体テスト
 *
 * 検証: セッションタイプ別ロード、ファイル欠落、BOOTSTRAP、日次メモリ、
 *       context フォーマット、truncate、空ワークスペース
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadWorkspaceContext } from "../src/workspace-loader.js";
import { setLogLevel } from "../src/utils/logger.js";

setLogLevel("error");

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** ヘルパー: ワークスペースファイルを作成 */
async function writeWsFile(name, content) {
  const dir = path.dirname(path.join(tmpDir, name));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(tmpDir, name), content, "utf-8");
}

describe("WorkspaceLoader", () => {
  it("cron プロファイル: SOUL.md のみロード", async () => {
    await writeWsFile("SOUL.md", "I am a cron agent.");
    await writeWsFile("USER.md", "User profile data");
    await writeWsFile("MEMORY.md", "Long term memory");

    const { context, loadedFiles } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "cron",
    });

    assert.ok(context.includes("<SOUL>"));
    assert.ok(context.includes("I am a cron agent."));
    assert.ok(!context.includes("<USER>")); // cron では USER を読まない
    assert.ok(!context.includes("<MEMORY>")); // cron では MEMORY を読まない
    assert.deepEqual(loadedFiles, ["SOUL.md"]);
  });

  it("main プロファイル: SOUL + USER + IDENTITY + MEMORY ロード", async () => {
    await writeWsFile("SOUL.md", "Soul content");
    await writeWsFile("USER.md", "User content");
    await writeWsFile("IDENTITY.md", "Identity content");
    await writeWsFile("MEMORY.md", "Memory content");

    const { context, loadedFiles } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "main",
    });

    assert.ok(context.includes("<SOUL>"));
    assert.ok(context.includes("<USER>"));
    assert.ok(context.includes("<IDENTITY>"));
    assert.ok(context.includes("<MEMORY>"));
    assert.equal(loadedFiles.length, 4);
  });

  it("group プロファイル: MEMORY.md を読まず GROUP_MEMORY.md を読む", async () => {
    await writeWsFile("SOUL.md", "Soul");
    await writeWsFile("USER.md", "User");
    await writeWsFile("MEMORY.md", "Private long-term memory");
    await writeWsFile("GROUP_MEMORY.md", "Shared group context");

    const { context, loadedFiles } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "group",
    });

    assert.ok(!context.includes("Private long-term memory")); // MEMORY.md は読まない
    assert.ok(context.includes("Shared group context")); // GROUP_MEMORY は読む
    assert.ok(loadedFiles.includes("GROUP_MEMORY.md"));
    assert.ok(!loadedFiles.includes("MEMORY.md"));
  });

  it("ファイル欠落: always は warn、optional はサイレント", async () => {
    // SOUL.md のみ作成（USER.md は欠落 = warn）
    await writeWsFile("SOUL.md", "Soul only");

    const { context, loadedFiles } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "main",
    });

    assert.ok(context.includes("<SOUL>"));
    assert.equal(loadedFiles.length, 1); // SOUL のみ
    // USER.md 欠落でもエラーにはならない
  });

  it("BOOTSTRAP.md 存在時: context に含まれ bootstrapFound=true", async () => {
    await writeWsFile("SOUL.md", "Soul");
    await writeWsFile("BOOTSTRAP.md", "Run onboarding steps here");

    const { context, loadedFiles, bootstrapFound } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "main",
    });

    assert.equal(bootstrapFound, true);
    assert.ok(context.includes("<BOOTSTRAP>"));
    assert.ok(context.includes("Run onboarding steps here"));
    assert.ok(loadedFiles.includes("BOOTSTRAP.md"));
  });

  it("BOOTSTRAP.md 非存在: bootstrapFound=false", async () => {
    await writeWsFile("SOUL.md", "Soul");

    const { bootstrapFound } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "main",
    });

    assert.equal(bootstrapFound, false);
  });

  it("日次メモリ: today.md がロードされる", async () => {
    await writeWsFile("SOUL.md", "Soul");
    await writeWsFile("USER.md", "User");

    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${d}`;

    await writeWsFile(`memory/${dateStr}.md`, "Today's log entry");

    const { context, loadedFiles } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "main",
    });

    assert.ok(context.includes("Today's log entry"));
    assert.ok(loadedFiles.includes(`memory/${dateStr}.md`));
  });

  it("日次メモリ非存在でもエラーにならない", async () => {
    await writeWsFile("SOUL.md", "Soul");

    const { context } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "main",
    });

    // memory/ ディレクトリが存在しなくてもクラッシュしない
    assert.ok(context.includes("<SOUL>"));
  });

  it("context フォーマット: XML タグで囲まれている", async () => {
    await writeWsFile("SOUL.md", "Soul text here");

    const { context } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "cron",
    });

    assert.ok(context.startsWith("<SOUL>"));
    assert.ok(context.includes("</SOUL>"));
    assert.ok(context.includes("Soul text here"));
  });

  it("空ワークスペース: context が空文字列、エラーなし", async () => {
    // ファイルなし
    const { context, loadedFiles, bootstrapFound } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "cron",
    });

    assert.equal(context, "");
    assert.equal(loadedFiles.length, 0);
    assert.equal(bootstrapFound, false);
  });

  it("truncate: maxContextChars 超過時に priority 低いものが削られる", async () => {
    await writeWsFile("SOUL.md", "S".repeat(100));
    await writeWsFile("USER.md", "U".repeat(100));
    // MEMORY.md は priority 3（最後に削られる）
    await writeWsFile("MEMORY.md", "M".repeat(5000));

    const { context, loadedFiles } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "main",
      maxContextChars: 500,
    });

    // SOUL と USER は残っている（priority 1）
    assert.ok(context.includes("<SOUL>"));
    assert.ok(context.includes("<USER>"));
    // MEMORY は truncate されているか、完全に削られている
    assert.ok(context.length <= 600); // 多少の余裕
  });

  it("AGENTS.md: 全プロファイルで optional ロードされる", async () => {
    await writeWsFile("SOUL.md", "Soul");
    await writeWsFile("USER.md", "User");
    await writeWsFile("AGENTS.md", "Agent behavior rules");

    // main プロファイル
    const mainResult = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "main",
    });
    assert.ok(mainResult.loadedFiles.includes("AGENTS.md"), "main loads AGENTS.md");
    assert.ok(mainResult.context.includes("<AGENTS>"), "main context has <AGENTS> tag");

    // cron プロファイル
    const cronResult = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "cron",
    });
    assert.ok(cronResult.loadedFiles.includes("AGENTS.md"), "cron loads AGENTS.md");

    // group プロファイル
    const groupResult = await loadWorkspaceContext({
      workspacePath: tmpDir,
      sessionType: "group",
    });
    assert.ok(groupResult.loadedFiles.includes("AGENTS.md"), "group loads AGENTS.md");
  });

  it("デフォルト sessionType は main", async () => {
    await writeWsFile("SOUL.md", "Soul");
    await writeWsFile("USER.md", "User");
    await writeWsFile("MEMORY.md", "Memory");

    const { loadedFiles } = await loadWorkspaceContext({
      workspacePath: tmpDir,
      // sessionType 指定なし → デフォルト "main"
    });

    // main プロファイル: USER.md と MEMORY.md が読まれるはず
    assert.ok(loadedFiles.includes("USER.md"));
    assert.ok(loadedFiles.includes("MEMORY.md"));
  });
});
