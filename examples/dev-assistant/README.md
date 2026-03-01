# Dev Assistant — Development AI Partner

> This template contains placeholder strings like `[YOUR_NAME]`, `[YOUR_REPO]` for documentation purposes only. No real secrets are included.

openclaw-cc to build a development-focused AI assistant that helps you ship safely and steadily.

## What it does

- **Daily dev briefing** — Git status, open PRs, CI results, blockers via Telegram
- **Approval-first workflow** — Read → Propose → Approve → Execute → Verify
- **Session persistence** — Continuous conversation with context across messages
- **Long-term memory** — Architecture decisions, known pitfalls, useful commands

## Architecture

Same 4-layer structure as [BUNSHIN](../bunshin/):

```
Layer 4: Dev actions (briefing, review drafts, investigation)
    ↑
Layer 3: Channel (Telegram notifications + approval)
    ↑
Layer 2: Engine (openclaw-cc core: cron, session, delivery, agent)
    ↑
Layer 1: Context (MEMORY.md, repo info, tech stack, decisions)
```

## Setup

### Prerequisites

- **openclaw-cc** set up ([README.md](../../README.md) Quick Start complete)
- Telegram Bot Token (create via [@BotFather](https://t.me/botfather))

### Step 1: Copy templates

```bash
cd /path/to/openclaw-cc

# Workspace files
cp examples/dev-assistant/workspace/SOUL.md workspace/SOUL.md
cp examples/dev-assistant/workspace/IDENTITY.example.md workspace/IDENTITY.md
cp examples/dev-assistant/workspace/AGENTS.md workspace/AGENTS.md
cp examples/dev-assistant/workspace/TOOLS.example.md workspace/TOOLS.md
cp examples/dev-assistant/workspace/USER.example.md workspace/USER.md
cp examples/dev-assistant/workspace/MEMORY.example.md workspace/MEMORY.md
cp examples/dev-assistant/workspace/HEARTBEAT.md workspace/HEARTBEAT.md
cp examples/dev-assistant/workspace/GROUP_MEMORY.example.md workspace/GROUP_MEMORY.md

# CronJob
cp examples/dev-assistant/cron/jobs.example.json data/cron/jobs.json

# Claude Code rules (optional)
mkdir -p .claude/rules
cp examples/dev-assistant/rules/*.md .claude/rules/
```

### Step 2: Fill in your info

Replace `[PLACEHOLDER]` values in these files:

| File | Content |
|------|---------|
| `workspace/USER.md` | Name, OS, repos, CI, preferences |
| `workspace/IDENTITY.md` | Project description, tech stack |
| `workspace/TOOLS.md` | GitHub org, CI URL, monitoring |
| `workspace/MEMORY.md` | Architecture notes, known pitfalls |
| `workspace/SOUL.md` | Your name (signature) |
| `workspace/AGENTS.md` | Your name (signature) |

### Step 3: Configure

```bash
# Copy example files and fill in your values
cp .env.example .env
cp config/default.example.json config/default.json
```

Edit `.env` — set your Telegram Bot Token:
```
TELEGRAM_BOT_TOKEN=your-token-here
```

Edit `config/default.json` — set your Telegram chat ID:
```json
{
  "telegram": {
    "defaultChatId": "-1001234567890",
    "allowedChatIds": ["-1001234567890"],
    "pollingIntervalMs": 3000
  }
}
```

> **Note:** `.env` and `config/default.json` are gitignored — they will not be committed. Do not use `git add -f` on these files.

### Step 4: Configure CronJob

Edit `data/cron/jobs.json` and replace `[YOUR_TELEGRAM_CHAT_ID]`:

```bash
sed -i '' 's/\[YOUR_TELEGRAM_CHAT_ID\]/-1001234567890/g' data/cron/jobs.json
```

### Step 5: Run

```bash
node src/index.js
```

Test via Telegram:
1. Send a message — does it respond with dev-focused context?
2. Ask "what's the git status?" — does it understand your repos?
3. Check `workspace/memory/` — is today's file created?

## Extending

### Add PR review capability

Update the CronJob message in `data/cron/jobs.json` to check PRs:

```json
{
  "id": "pr-review-reminder",
  "name": "PR Review Reminder",
  "enabled": true,
  "agentId": "main",
  "schedule": { "kind": "every", "every": 3600000 },
  "payload": {
    "kind": "agentTurn",
    "model": "haiku",
    "message": "Check for open PRs that need review. List title, author, age, and CI status. If none pending, return NO_REPLY.",
    "timeoutSeconds": 60
  },
  "delivery": {
    "channel": "telegram",
    "to": "[YOUR_TELEGRAM_CHAT_ID]",
    "bestEffort": true
  }
}
```

### Add test failure monitoring

```json
{
  "id": "test-monitor",
  "name": "Test Failure Monitor",
  "enabled": true,
  "agentId": "main",
  "schedule": { "kind": "every", "every": 1800000 },
  "payload": {
    "kind": "agentTurn",
    "model": "haiku",
    "message": "Run tests and report failures. For each failure: file, test name, error summary, and suggested fix. If all pass, return NO_REPLY.",
    "timeoutSeconds": 120
  },
  "delivery": {
    "channel": "telegram",
    "to": "[YOUR_TELEGRAM_CHAT_ID]",
    "bestEffort": true
  }
}
```

## File structure

```
examples/dev-assistant/
├── README.md                        ← This file
├── workspace/
│   ├── SOUL.md                      ← Core principles (correctness > safety > clarity > speed)
│   ├── IDENTITY.example.md          ← Agent role and context
│   ├── AGENTS.md                    ← Working protocol + briefing format
│   ├── TOOLS.example.md             ← Allowed/forbidden commands
│   ├── USER.example.md              ← Developer profile
│   ├── MEMORY.example.md            ← Long-term technical memory
│   ├── HEARTBEAT.md                 ← Health check (empty by default)
│   └── GROUP_MEMORY.example.md      ← Team-safe shared context
├── cron/
│   └── jobs.example.json            ← Daily dev briefing CronJob
└── rules/
    └── safety.md                    ← Approval-first + secret protection
```
