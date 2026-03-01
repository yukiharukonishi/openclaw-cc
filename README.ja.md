> **Language:** [English](README.md) | 日本語

# openclaw-cc — OpenClaw reproduced with Claude Code

[OpenClaw](https://www.npmjs.com/package/openclaw) の自律エージェント基盤を **`claude -p`** だけで再現。Gateway 不要、ゼロ依存、Node.js 22+。

## What is OpenClaw?

OpenClaw は「AI エージェントの人格・記憶・行動を Markdown ファイルで定義し、複数チャネルに自律的に配信する」マルチチャネル AI エージェントゲートウェイです。

その特徴的な設計思想:

- **Markdown でエージェントの人格を定義する** — `SOUL.md` に行動原則、`USER.md` にユーザー情報、`IDENTITY.md` にキャラクター。設定ファイルではなく、人間が読み書きできる Markdown で管理する
- **Markdown で記憶を永続化する** — 日次ログ (`memory/YYYY-MM-DD.md`) と長期メモリ (`MEMORY.md`) に知識を蓄積。セッションが終わっても記憶が残り、次回起動時に自動で読み込まれる
- **セッションタイプで情報量を制御する** — DM では全ファイルを読み、cron ジョブでは最小限だけ読み、グループチャットでは個人情報を含むファイルを読まない
- **「異常なしなら黙る」NO_REPLY パターン** — エージェントが `NO_REPLY` と返せば配信をスキップ。通知疲れを防ぐ OpenClaw のコアパターン
- **cron → agent → delivery の三層構造** — スケジュール・AI実行・配信を分離し、途中で落ちても再開できる耐障害設計

## What is openclaw-cc?

上記の OpenClaw 設計を、**Gateway サーバーなし** で再現するプロジェクトです。

OpenClaw は通常、Gateway サーバー（常駐プロセス + Web UI + チャネル認証）を介して動作しますが、
「定期タスク + Telegram 通知 + Markdown 記憶管理」だけなら、もっと軽い構成で十分再現できます:

| OpenClaw の仕組み | openclaw-cc での再現方法 |
|------------------|----------------------|
| Gateway サーバーでチャネル接続 | **Telegram Bot API を直接呼び出し**（Gateway 不要） |
| OpenClaw の AI エンジン | **`claude -p`**（Claude Code のヘッドレス CLI） |
| Web UI でジョブ管理 | **`jobs.json`** を直接編集（ブラウザ不要） |
| Markdown Workspace | **そのまま再現**（SOUL.md, USER.md, memory/ 等） |
| セッション管理 + 記憶 | **そのまま再現**（daily/idle reset, JSONL 履歴） |
| 配信キュー + リトライ | **そのまま再現**（atomic write, dead-letter） |

### Gateway 不要 — ブラウザレスで完結

**不要なもの:**
- Gateway サーバー（常駐プロセス）
- Web UI / ブラウザ / ログインセッション
- Webhook サーバー（このプロジェクト単体では）

**必要なもの:**
- `claude -p` が動く環境（Claude Code CLI インストール済み）
- Node.js 22+
- Telegram Bot Token（送信する場合のみ）
- OS のスケジューラ（常時起動したいなら systemd / LaunchAgent 等）

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      openclaw-cc                         │
│                                                         │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────┐ │
│  │   Cron    │───>│ Agent Runner │───>│   Delivery    │ │
│  │ Scheduler │    │ (claude -p)  │    │    Queue      │ │
│  └──────────┘    └──────┬───────┘    └──────┬────────┘ │
│       │                 │                    │          │
│       │           ┌─────┴──────┐       ┌────┴────────┐ │
│       │           │  Session   │       │  Telegram    │ │
│       └──────────>│  Manager   │       │   Adapter    │ │
│                   └────────────┘       └─────────────┘ │
│                                                         │
│  ┌─────────────────┐  ┌──────────────────────────────┐ │
│  │ Workspace Loader │  │ Memory Manager               │ │
│  │ (Markdown→XML)   │  │ (Daily + Long-term + Prune)  │ │
│  └─────────────────┘  └──────────────────────────────┘ │
│                                                         │
│  Utils: storage.js (atomic write + lock + JSONL)        │
│         logger.js  (JSON structured logging)            │
│         session-key.js (OpenClaw-compatible keys)       │
└─────────────────────────────────────────────────────────┘
```

## 再現できている OpenClaw 機能の詳細

| OpenClaw の機能 | 何をするものか | openclaw-cc での再現 |
|---|---|---|
| **Markdown Workspace** | SOUL.md 等でエージェントの人格・行動原則を定義 | `workspace/*.md` + `workspace-loader.js` で再現。XML タグに変換して systemPrompt に注入 |
| **Memory System** | 日次ログ + 長期メモリを Markdown で蓄積・読み込み | `memory-manager.js` で再現。daily は `memory/YYYY-MM-DD.md`、long-term は `MEMORY.md` |
| **Session-type Profiles** | DM/cron/group で読み込むファイルを変える | main/cron/group の3プロファイル。group では個人情報ファイルを読まない |
| **NO_REPLY Suppression** | 「異常なしなら黙る」— 無駄な通知を防ぐ | cron-scheduler.js で判定。空文字列 or "NO_REPLY" なら配信スキップ |
| **Cron Scheduler** | 定期/固定時刻でエージェントを自律実行 | every(ms間隔) / at(1回) を実装。cron 式は Phase 3 |
| **Deterministic Stagger** | 同時刻の複数ジョブの実行をズラす | `MD5(jobId) % staggerMs` — 再起動しても同じオフセット |
| **Delivery Queue** | 配信失敗時のリトライ・dead-letter 管理 | atomic write + O_EXCL で耐障害。bestEffort(部分成功) 対応 |
| **Session Management** | セッションの作成・リセット・アーカイブ | daily(時刻跨ぎ) + idle(24h) のリセットポリシー |
| **Agent Loop** | AI モデルを呼び出してセッション継続 | `claude -p` の CLI session / JSONL fallback / Stateless の三段構え |
| **Telegram Adapter** | チャネルへの配信 + 受信 | Bot API 直接呼び出し + Long Polling で双方向通信（Gateway 不要で再現）。グループ全トピック + DM 対応 |
| **Cost-aware Model Routing** | タスク難易度に応じて Haiku/Sonnet/Opus を選択 | `payload.model` でジョブごとに指定 |
| **Gateway** | チャネル認証・メッセージルーティング | **不要** — Bot API sendMessage で直接送信 |

### Cost-aware Model Routing (Haiku / Sonnet / Opus)

ジョブごとに `payload.model` を指定して、タスクの難易度に応じたモデルを選択します:

```
haiku  → ヘルスチェック、通知要約、YES/NO 判定（低コスト）
sonnet → 定型返信の下書き、日次レポート（標準）
opus   → 複雑な判断、見積もり対応、クライアント案件（高精度）
```

OpenClaw と同じく、全ジョブを最高モデルで回すのではなく、**難易度に応じたモデル選択でコストを最適化** する設計です。
詳細は [`examples/jobs.example.md`](examples/jobs.example.md) を参照。

### まだ再現していない機能

| 機能 | 状態 |
|------|------|
| Cron 式 (`0 9 * * *`) | Phase 3 予定 |
| Session Compaction（古い履歴の要約圧縮） | Phase 3 予定 |
| Model Failover（AI モデルの自動切替） | Phase 3 予定 |
| Webhook 受信 | Long Polling で実装済み。Webhook は Phase 3 予定 |
| 追加チャネル（Slack, Discord） | Phase 3 予定 |

## Quick Start

### 1. Setup

```bash
git clone <repo-url>
cd openclaw-cc
cp .env.example .env
cp config/default.example.json config/default.json
```

### 2. Telegram Bot を作成

1. [@BotFather](https://t.me/BotFather) で `/newbot` → Bot Token を取得
2. `.env` に記入:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   ```
3. `config/default.json` を設定:
   ```json
   {
     "agents": {
       "defaults": {
         "model": "sonnet",
         "timeoutSeconds": 300,
         "allowedTools": "Bash,Read,Write,Edit,Grep,Glob",
         "maxBudgetUsd": "0.50"
       }
     },
     "telegram": {
       "defaultChatId": "-1001234567890",
       "defaultTopicId": 6,
       "allowedChatIds": ["-1001234567890"],
       "pollingIntervalMs": 3000
     }
   }
   ```

> **Chat ID の調べ方**: Bot をグループに追加後、`https://api.telegram.org/bot<TOKEN>/getUpdates` にアクセスすると `chat.id` が見えます。

### 3. Cron Jobs を設定

```bash
mkdir -p data/cron
cp examples/jobs.example.json data/cron/jobs.json
```

`jobs.json` を編集して、Telegram の宛先を実際の値に変更:
```json
{
  "delivery": {
    "channel": "telegram",
    "to": "-1001234567890:topic:6"
  }
}
```

> **Note**: Currently only `kind: "every"` and `kind: "at"` are supported. Cron expressions (`kind: "cron"`) are planned for Phase 3. Unknown kinds are logged as warnings and skipped.

### 4. Workspace をセットアップ（Markdown メモリ）

```bash
cp workspace/USER.example.md workspace/USER.md
cp workspace/MEMORY.example.md workspace/MEMORY.md
cp workspace/GROUP_MEMORY.example.md workspace/GROUP_MEMORY.md
```

`workspace/USER.md` を編集してプロファイルを設定（必須ではないが推奨）。

### 5. Run

```bash
node src/index.js
```

起動すると:
1. `.env` と `config/default.json` を読み込み
2. Delivery Queue の未処理をスキャン（再起動時の取りこぼし防止）
3. Telegram Poller 起動（`allowedChatIds` 設定時のみ — Long Polling で受信開始）
4. Cron Scheduler が全ジョブをスケジュール
5. 30秒間隔で Delivery Queue を再スキャン
6. `SIGTERM`/`SIGINT` で graceful shutdown

> **Note**: `allowedChatIds` が空または未設定の場合、Telegram 受信は無効（送信専用）です。

## Cron Jobs の仕組み

### ジョブの種類

| kind | 動作 | 例 |
|------|------|-----|
| `every` | ms 間隔で繰り返し | 5分ごとにヘルスチェック |
| `at` | 固定時刻に1回実行 | 「明日の9時に挨拶を送る」 |
| `cron` | cron 式 (Phase 3) | `"0 9 * * *"` |

### ジョブの実行フロー

```
1. CronScheduler が setTimeout でジョブをスケジュール
2. 時刻到達 → SessionManager でセッション解決
3. AgentRunner が claude -p を実行
   - Workspace Context を systemPrompt に自動注入
   - sessionType に応じたファイルだけをロード
4. 出力が "NO_REPLY" → 配信スキップ（異常なしの意味）
5. 出力あり → DeliveryQueue に enqueue
6. DeliveryQueue → Telegram Adapter → Bot API で送信
```

### NO_REPLY パターン

Agent が `NO_REPLY` と返すと配信をスキップします。
これにより「異常なし」のとき無駄な通知が飛びません:

```
message: "Check system health. If everything is normal, reply with exactly NO_REPLY."
```

### Stagger（実行時刻ズラし）

同じ interval の複数ジョブが同時実行されるのを防ぎます:
```
delay = MD5(jobId) % staggerMs
```
再起動しても同じオフセットが再現される決定論的アルゴリズムです。

## Markdown Memory System

OpenClaw の最も特徴的な機能を再現しています。
エージェントの「人格」「記憶」「スキル」を **Markdown ファイル** で管理します。

### Workspace ファイル構成

```
workspace/
├── SOUL.md              ← エージェントの行動原則（全セッションで必ず読む）
├── USER.md              ← ユーザープロファイル（main/group で読む）
├── IDENTITY.md          ← エージェント名、タイプ、キャラクター
├── TOOLS.md             ← 利用可能なツール・API一覧
├── AGENTS.md            ← セッション開始手順、メモリ管理ルール、グループチャット行動指針
├── HEARTBEAT.md         ← ヘルスチェック用チェックリスト
├── BOOTSTRAP.md         ← 初回セットアップ（完了後に削除）
├── MEMORY.md            ← 長期メモリ（main セッションのみ読み込み）
├── GROUP_MEMORY.md      ← グループ共有メモリ（個人情報なし）
└── memory/
    ├── 2026-03-01.md    ← 今日の日次ログ
    └── 2026-02-28.md    ← 昨日のログ（today + yesterday を自動読み込み）
```

### Session Type によるロード制御

エージェント実行時に `sessionType` を指定することで、読み込むファイルが変わります:

| sessionType | 読むファイル | ユースケース |
|-------------|-------------|-------------|
| **main** (デフォルト) | SOUL, USER, IDENTITY, AGENTS, TOOLS, MEMORY, daily memory, BOOTSTRAP | 通常のDM対話 |
| **cron** | SOUL, IDENTITY, AGENTS | 定期ジョブ（軽量、トークン節約） |
| **group** | SOUL, USER, IDENTITY, AGENTS, GROUP_MEMORY, daily memory | グループチャット（MEMORY.mdは読まない=個人情報保護） |

> **安全設計**: sessionType 未指定時は `"main"`（全ロード）がデフォルト。忘れても情報が足りなくなる方向には倒れません。

### コンテキスト注入の仕組み

Agent Runner が `claude -p` を呼ぶ前に、Workspace Loader が Markdown ファイルを読み込み、
**XML タグで囲んで systemPrompt の先頭に自動注入** します:

```xml
<SOUL>
You are an autonomous agent...
</SOUL>

<USER>
Name: Alex
Timezone: Asia/Tokyo
</USER>

<DAILY_MEMORY_2026-03-01>
## 09:15:30 — Heartbeat check
All systems normal.
</DAILY_MEMORY_2026-03-01>

(ここに元の systemPrompt が続く)
```

### トークン圧迫対策

`maxContextChars`（デフォルト 8000 文字）を超えた場合、優先度の低いものから自動で削ります:

| 優先度 | ファイル | 理由 |
|--------|---------|------|
| 1 (保持) | SOUL, USER, BOOTSTRAP | エージェントの基本動作に必須 |
| 2 (中) | IDENTITY, TOOLS, daily memory | あると良いが必須ではない |
| 3 (最後に削る) | MEMORY, GROUP_MEMORY | 長大になりやすいため |

### Memory Manager

日次メモリと長期メモリのファイル管理を行います:

```javascript
import { MemoryManager } from "./src/memory-manager.js";

const mm = new MemoryManager({ workspacePath: "./workspace" });
await mm.init();

// 日次ログに追記 → workspace/memory/2026-03-01.md
await mm.appendDaily({
  title: "Heartbeat check",
  body: "All systems normal. CPU 23%, memory 45%."
});

// 長期メモリに追記 → workspace/MEMORY.md
await mm.appendLongTerm({
  title: "Server restart pattern",
  body: "Server tends to need restart on Mondays after batch processing."
});

// 30日より古い日次ログを削除
await mm.pruneOldDaily();
```

## Telegram 接続

### 前提

- Telegram Bot Token を取得済み（@BotFather で作成）
- Bot をグループに追加済み

### 動作モデル

openclaw-cc の Telegram 連携は **双方向** です:

```
送信（Cron → 通知）:
  Cron Job → Agent Runner → Delivery Queue → Telegram Adapter → sendMessage

受信（ユーザー → Bot）:
  getUpdates (Long Polling) → TelegramPoller → Agent Runner → sendMessage で直接応答
```

受信時は **Stateless モード** (`--no-session-persistence`) で実行されます。
これにより連続メッセージでも安定動作し、セッション破損が起きません。

安全制限も自動適用されます:
- `--allowedTools Bash,Read,Write,Edit,Grep,Glob` — ツール制限
- `--max-budget-usd 0.50` — コスト上限（設定で変更可能）

受信を有効にするには `config/default.json` に `allowedChatIds` を設定します:

```json
{
  "telegram": {
    "allowedChatIds": ["-1001234567890", "123456789"],
    "pollingIntervalMs": 3000
  }
}
```

**allowedChatIds のフォーマット:**
```
"-1001234567890"              → グループ全体（全トピック許可）
"-1001234567890:topic:6"      → グループ内の特定トピックのみ許可
"123456789"                   → DM（個人チャット）を許可
```

`allowedChatIds` が空の場合、受信は無効（送信専用）のまま動作します。

### 宛先フォーマット

OpenClaw 互換の `"to"` フォーマット:
```
"-1001234567890"              → グループへ送信
"-1001234567890:topic:6"      → グループ内のトピック6へ送信
```

### 4096 文字チャンク

Telegram の1メッセージ上限は4096文字。長いメッセージは改行優先で自動分割されます。

## Requirements

- **Node.js 22+** (uses `node:test`, `crypto.randomUUID()`, native `fetch`)
- **Claude Code CLI** (`claude` command available in PATH)
- **Zero runtime dependencies** — everything uses Node.js standard library

> **Note on `.env` parsing**: Built-in parser supports `KEY=VALUE` format only.
> `export KEY=VALUE` is not supported. Single/double quotes around values are stripped.
> Existing environment variables are never overwritten.

## Key Design Decisions

### Three-Tier Agent Runner

用途に応じて3つの実行モードを自動選択:

- **Mode 1 (CLI session)**: `claude -p --session-id UUID` — Claude Code がセッションを自動管理。Cron ジョブの継続実行に最適
- **Mode 2 (JSONL fallback)**: 自前で `{sessionId}.jsonl` を管理し、プロンプトに注入 — Mode 1 が使えない環境の保険
- **Mode 3 (Stateless)**: `claude -p --no-session-persistence` — 毎回新規セッション。チャットメッセージ（Telegram 受信）に使用

Mode 1/2 は初回実行時に自動検出し、結果をキャッシュ。Mode 3 は `noSessionPersistence: true` で明示的に選択します。

### Crash Resistance

- **Atomic write**: `.tmp` + `rename` パターン — プロセス途中停止でもファイル破損しない
- **File lock**: `.lock` + O_EXCL — 排他制御（stale lock は TTL で自動解放）
- **Processing flag**: `.processing` ファイルで二重処理防止（configurable stale 判定）
- **Memory writes**: 全 append 操作に `withLock()` 排他制御

### Personal Data Protection (OSS向け)

`workspace/USER.md`, `workspace/MEMORY.md`, `workspace/GROUP_MEMORY.md` は **gitignore 対象** です。
リポジトリにはテンプレート（`.example.md`）のみが含まれます:

```
workspace/USER.example.md      ← git 追跡（テンプレート）
workspace/USER.md              ← .gitignore（ユーザーがコピーして編集）
```

`git add .` しても個人データが公開リポジトリに混入しません。

## Project Structure

```
openclaw-cc/
├── src/
│   ├── index.js                 ← Entry point (daemon)
│   ├── agent-runner.js          ← claude -p wrapper (three-tier: CLI/JSONL/Stateless + workspace injection)
│   ├── cron-scheduler.js        ← Cron scheduler (every/at + stagger + NO_REPLY)
│   ├── delivery-queue.js        ← Crash-resistant delivery queue
│   ├── session-manager.js       ← Session lifecycle (daily/idle reset)
│   ├── workspace-loader.js      ← Markdown workspace → XML context
│   ├── memory-manager.js        ← Daily + long-term memory management
│   ├── channel-adapters/
│   │   └── telegram.js          ← Telegram Bot API adapter (send)
│   ├── channel-receivers/
│   │   └── telegram-poller.js   ← Telegram Long Polling receiver
│   └── utils/
│       ├── storage.js           ← Atomic write + file lock + JSONL
│       ├── session-key.js       ← Session key generation/parsing
│       └── logger.js            ← JSON structured logging
├── workspace/                   ← Agent workspace context (Markdown)
│   ├── SOUL.md                  ← Agent behavior principles
│   ├── AGENTS.md                ← Session procedure + memory rules
│   ├── HEARTBEAT.md             ← Health check checklist
│   ├── IDENTITY.md              ← Agent name and character
│   ├── TOOLS.md                 ← Available tools configuration
│   ├── BOOTSTRAP.md             ← First-run onboarding (delete after use)
│   ├── *.example.md             ← Templates for personal data files
│   └── memory/                  ← Daily logs (YYYY-MM-DD.md, gitignored)
├── config/
│   └── default.example.json     ← Configuration template
├── examples/
│   └── jobs.example.json        ← Sample cron jobs (3 examples)
├── test/                        ← Tests (node:test, 62 tests)
└── data/                        ← Runtime data (gitignored)
    ├── cron/jobs.json
    ├── sessions/
    ├── delivery-queue/
    └── dead-letter/
```

## Testing

```bash
npm test
# or
node --test test/*.test.js
```

62 tests across 7 suites:

| Suite | Tests | Coverage |
|-------|-------|---------|
| `agent-runner.test.js` | 9 | CLI/JSONL/Stateless modes, history injection, workspace context, noSessionPersistence |
| `cron-scheduler.test.js` | 7 | every, at, NO_REPLY, stagger, exitCode error, disabled |
| `delivery-queue.test.js` | 7 | enqueue→processAll, retry, bestEffort, TTL, dead-letter, idempotency |
| `session-manager.test.js` | 8 | create, resolve, idle/daily reset, JSONL, multi-day crossing |
| `workspace-loader.test.js` | 13 | 3 profiles, BOOTSTRAP, daily memory, truncation, AGENTS.md loading, default sessionType |
| `memory-manager.test.js` | 8 | appendDaily/LongTerm, prune, header generation, .gitkeep handling |
| `telegram-poller.test.js` | 10 | Long Polling, allowedChatIds filter, agent execution, offset, error resilience |

## Phase 3 Roadmap

- [ ] Cron expressions (`kind: "cron"`)
- [ ] Session compaction (summarize old messages to save tokens)
- [ ] Code fence protection (don't split Telegram chunks mid-codeblock)
- [ ] Workspace strict mode (configurable: throw vs warn on load failure)
- [ ] Model failover (primary → fallback)
- [ ] Additional channel adapters (Slack, Discord)

## Examples

### BUNSHIN — ビジネスAIパートナー

`examples/bunshin/` に、openclaw-cc を使って自律型ビジネスAIパートナーを構築するためのテンプレート集があります。

特徴:
- **日本語対応** — workspace ファイルが日本語で記述済み
- **ビジネス特化** — クライアント管理、プロジェクト管理、チーム管理のテンプレート
- **コンテキスト中心設計** — 「メッセージが来た→処理」ではなく「全情報を持ち先回り行動」
- **CronJob サンプル** — 朝のブリーフィング + 1時間ごとの先回りチェック

詳細: [`examples/bunshin/README.md`](examples/bunshin/README.md)

### Dev Assistant — 開発AIパートナー

`examples/dev-assistant/` に、openclaw-cc を使って開発支援AIアシスタントを構築するためのテンプレート集があります。

特徴:
- **英語ベース** — 国際チーム・英語プロジェクト向け
- **開発特化** — Git 状態、PR、CI、テスト失敗の監視・要約
- **Approval-first** — Read → Propose → Approve → Execute → Verify の安全ループ
- **CronJob サンプル** — 毎日の開発ブリーフィング（拡張例: PRリマインド、テスト監視）

詳細: [`examples/dev-assistant/README.md`](examples/dev-assistant/README.md)

## License

MIT
