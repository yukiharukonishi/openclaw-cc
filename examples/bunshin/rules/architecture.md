# Architecture Decisions

## 設計思想: コンテキスト中心

### なぜ「チャネル中心」ではダメか
従来のチャネル中心システムは「メッセージが来た → 処理する」という設計。
これだと AI は「メッセージの内容」しか知らず、先回りした提案ができない。

BUNSHIN は「自分の全情報を持ち、それを土台に行動する」コンテキスト中心の設計。
AI はメール・予定・人脈・過去の判断を全て知っている状態で動く。

```
チャネル中心（従来）:
  メッセージ受信 → 分類 → タスク → AI解決
  起点 = メッセージ

コンテキスト中心（BUNSHIN）:
  全情報（人脈 + 予定 + タスク + 履歴 + メール）→ AI が文脈を理解 → 先回り行動
  起点 = 自分というコンテキスト
```

## 4層アーキテクチャ

```
Layer 4: 自律行動（先回り提案、リマインド、Telegram 自然会話）
    ↑
Layer 3: チャネル連携（メール取得、チャット取得、カレンダー同期）
    ↑
Layer 2: エンジン（cron, session, delivery, agent, memory, workspace）
    ↑
Layer 1: 情報土台（MEMORY.md, 人脈, プロジェクト, 履歴）
```

構築順序: Layer 1 → 2 → 3 → 4（土台から上へ）

## エンジン: openclaw-cc を使う

openclaw-cc には以下のモジュールがテスト付きで完成している:

| モジュール | ファイル | 役割 |
|-----------|---------|------|
| CronScheduler | cron-scheduler.js | 定期実行（every/at） |
| AgentRunner | agent-runner.js | claude -p ラッパー（CLI + JSONL 二段構え） |
| SessionManager | session-manager.js | セッション維持（daily/idle リセット） |
| DeliveryQueue | delivery-queue.js | 配信キュー（retry, TTL, dead-letter） |
| WorkspaceLoader | workspace-loader.js | 文脈注入（SOUL + USER + MEMORY） |
| MemoryManager | memory-manager.js | 日次 + 長期メモリ管理 |
| TelegramAdapter | channel-adapters/telegram.js | Telegram 送信 |
| TelegramPoller | channel-receivers/telegram-poller.js | Telegram 受信 |

## モデルルーティング方針

| 用途 | モデル | 理由 |
|------|--------|------|
| FYI 要約 | Haiku | 軽量・低コスト |
| 標準下書き | Sonnet | バランス |
| 複雑な判断・見積もり | Opus | 最高品質 |
| Telegram 会話 | Sonnet | 応答速度重視 |
| タスク分類 | Haiku | 大量処理向き |

## OpenClaw 標準マークダウン7ファイル

workspace/ に以下を配置:

| ファイル | 役割 | セッションタイプ別ロード |
|---------|------|----------------------|
| SOUL.md | エージェント人格・行動原則 | main, cron, group 全て |
| USER.md | ユーザー情報（名前, TZ, 好み） | main, group |
| IDENTITY.md | エージェント名・キャラクター | main, cron |
| AGENTS.md | セッション手順・メモリ規則 | main |
| TOOLS.md | 利用可能ツール一覧 | main |
| MEMORY.md | 長期記憶（個人情報含む） | main のみ |
| memory/YYYY-MM-DD.md | 日次ログ | main, group |
