# BUNSHIN — ビジネスAIパートナー

> This template contains placeholder strings like `[YOUR_NAME]`, `TOKEN`, `API_KEY` for documentation purposes only. No real secrets are included.

openclaw-cc を使って「自律型ビジネスAIパートナー」を構築するためのテンプレート集です。

## これは何か

「チャネル中心」（メッセージが来た → 処理する）ではなく、
「コンテキスト中心」（自分の全情報を持ち、先回りして行動する）設計のAIアシスタント。

## 完成すると何ができるか

- **Telegram で自然会話** — セッションが維持され、文脈が続く
- **朝のブリーフィング** — 未処理タスク・メール状態を自動で Telegram に通知
- **先回りチェック** — 未返信・期限切れを1時間ごとに検出して通知
- **長期記憶** — 重要な判断・学びを `workspace/memory/` に自動蓄積
- **ビジネスデータ照会** — タスク、メール、チャット履歴を Telegram から照会

## 4層アーキテクチャ

```
Layer 4: 自律行動（先回り提案、リマインド、自然会話）
    ↑
Layer 3: チャネル連携（メール、チャット、カレンダー）
    ↑
Layer 2: エンジン（openclaw-cc の src/）
    ↑
Layer 1: 情報土台（workspace/ のマークダウン群）
```

構築順序: Layer 1 → 2 → 3 → 4（土台から上へ）

## セットアップ手順

### 前提条件

- **openclaw-cc** がセットアップ済み（[README.md](../../README.md) の Quick Start 完了）
- Telegram Bot Token 取得済み（[@BotFather](https://t.me/botfather) で作成）

### Step 1: テンプレートをコピー

```bash
cd /path/to/openclaw-cc

# workspace ファイル
cp examples/bunshin/workspace/SOUL.md workspace/SOUL.md
cp examples/bunshin/workspace/IDENTITY.example.md workspace/IDENTITY.md
cp examples/bunshin/workspace/AGENTS.md workspace/AGENTS.md
cp examples/bunshin/workspace/TOOLS.example.md workspace/TOOLS.md
cp examples/bunshin/workspace/USER.example.md workspace/USER.md
cp examples/bunshin/workspace/MEMORY.example.md workspace/MEMORY.md
cp examples/bunshin/workspace/HEARTBEAT.md workspace/HEARTBEAT.md
cp examples/bunshin/workspace/GROUP_MEMORY.example.md workspace/GROUP_MEMORY.md

# data ディレクトリ
mkdir -p data/people data/projects
cp examples/bunshin/data/people/contact.example.md data/people/

# CronJob
cp examples/bunshin/cron/jobs.example.json data/cron/jobs.json

# Claude Code ルール（任意）
mkdir -p .claude/rules
cp examples/bunshin/rules/*.md .claude/rules/
```

### Step 2: 個人情報を埋める

以下のファイルの `[PLACEHOLDER]` を自分の情報で置き換えてください:

| ファイル | 内容 |
|---------|------|
| `workspace/USER.md` | 名前、会社、連絡先、署名ブロック |
| `workspace/IDENTITY.md` | 会社名、業務内容 |
| `workspace/TOOLS.md` | Telegram Bot名、チャットツール情報 |
| `workspace/MEMORY.md` | プロジェクト、チーム、人脈情報 |
| `workspace/SOUL.md` | 署名名（`[YOUR_NAME]` を置換） |
| `workspace/AGENTS.md` | 署名名（`[YOUR_NAME]` を置換） |

### Step 3: 設定

```bash
# テンプレートをコピーして、自分の値を入力
cp .env.example .env
cp config/default.example.json config/default.json
```

`.env` を編集 — Telegram Bot Token を設定:
```
TELEGRAM_BOT_TOKEN=your-token-here
```

`config/default.json` を編集 — Telegram チャットIDを設定:
```json
{
  "telegram": {
    "defaultChatId": "-1001234567890",
    "allowedChatIds": ["-1001234567890"],
    "pollingIntervalMs": 3000
  }
}
```

> **注意:** `.env` と `config/default.json` は gitignore 対象です。コミットされません。

### Step 4: CronJob の設定

`data/cron/jobs.json` を編集し、`[YOUR_TELEGRAM_CHAT_ID]` を実際のチャットIDに置換:

```bash
# 例: -1001234567890 に置換
sed -i '' 's/\[YOUR_TELEGRAM_CHAT_ID\]/-1001234567890/g' data/cron/jobs.json
```

### Step 5: 起動・動作確認

```bash
node src/index.js
```

Telegram で話しかけてみてください:
1. 「こんにちは」→ SOUL.md の人格が反映された応答が返るか
2. 「さっき何を聞いた？」→ セッションが維持されているか
3. `workspace/memory/` に今日の日付のファイルが作られているか

## カスタマイズガイド

### 関係者を追加する

```bash
cp data/people/contact.example.md data/people/tanaka.md
# tanaka.md の [PLACEHOLDER] を埋める
```

追加したら `workspace/MEMORY.md` の「アクティブプロジェクト」セクションにも反映してください。

### プロジェクトを追加する

```bash
cp data/projects/project.example.md data/projects/new-project.md
# new-project.md の [PLACEHOLDER] を埋める
```

### CronJob を追加する

`data/cron/jobs.json` の `jobs` 配列に新しいジョブを追加:

```json
{
  "id": "weekly-report",
  "name": "週次レポート",
  "enabled": true,
  "agentId": "main",
  "schedule": { "kind": "every", "every": 604800000 },
  "payload": {
    "kind": "agentTurn",
    "model": "sonnet",
    "message": "今週のレポートを作成してください...",
    "timeoutSeconds": 120
  },
  "delivery": {
    "channel": "telegram",
    "to": "[YOUR_TELEGRAM_CHAT_ID]",
    "bestEffort": true
  }
}
```

### 外部データを参照する

既存の業務システムのデータを読み取り専用で参照できます。
`workspace/TOOLS.md` の「外部データ参照」セクションにパスを追加し、
`workspace/AGENTS.md` の手順に参照方法を記載してください。

**重要:** 外部データは Read のみ。Write/Edit/削除は絶対禁止。

## ファイル構成

```
examples/bunshin/
├── README.md                     ← このファイル
├── workspace/
│   ├── SOUL.md                   ← 行動原則（日本語版）
│   ├── IDENTITY.example.md       ← エージェント名・キャラクター
│   ├── AGENTS.md                 ← セッション管理ルール
│   ├── TOOLS.example.md          ← ローカル環境情報
│   ├── USER.example.md           ← ユーザー情報
│   ├── MEMORY.example.md         ← 長期記憶
│   ├── HEARTBEAT.md              ← ヘルスチェック
│   └── GROUP_MEMORY.example.md   ← グループメモリ
├── data/
│   ├── people/
│   │   └── contact.example.md    ← 関係者テンプレート
│   └── projects/
│       └── project.example.md    ← プロジェクトテンプレート
├── cron/
│   └── jobs.example.json         ← CronJob サンプル
└── rules/
    ├── architecture.md           ← 4層アーキテクチャ説明
    └── safety.md                 ← 安全ルール
```
