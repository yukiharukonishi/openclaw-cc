> **Language:** English | [日本語](README.ja.md)

# openclaw-cc — OpenClaw reproduced with Claude Code

Reproduce [OpenClaw](https://www.npmjs.com/package/openclaw)'s autonomous agent platform using only **`claude -p`**. No gateway, zero dependencies, Node.js 22+.

## What is OpenClaw?

OpenClaw is a multi-channel AI agent gateway that defines agent personality, memory, and behavior through Markdown files and autonomously delivers across multiple channels.

Key design philosophy:

- **Define agent personality in Markdown** — `SOUL.md` for behavior principles, `USER.md` for user info, `IDENTITY.md` for character. Managed in human-readable Markdown, not config files
- **Persist memory in Markdown** — Accumulate knowledge in daily logs (`memory/YYYY-MM-DD.md`) and long-term memory (`MEMORY.md`). Memory survives across sessions and auto-loads on next startup
- **Control information by session type** — DM loads all files, cron jobs load only essentials, group chats skip files containing personal info
- **NO_REPLY pattern: "stay silent when nothing to report"** — Agent returns `NO_REPLY` to skip delivery. Prevents notification fatigue — a core OpenClaw pattern
- **Three-layer architecture: cron → agent → delivery** — Separates scheduling, AI execution, and delivery for crash-resistant design

## What is openclaw-cc?

This project reproduces the OpenClaw design **without a Gateway server**.

OpenClaw normally operates through a Gateway server (persistent process + Web UI + channel auth), but for "scheduled tasks + Telegram notifications + Markdown memory management", a much lighter setup works:

| OpenClaw approach | openclaw-cc reproduction |
|------------------|----------------------|
| Gateway server for channel connections | **Direct Telegram Bot API calls** (no Gateway) |
| OpenClaw AI engine | **`claude -p`** (Claude Code headless CLI) |
| Web UI for job management | **Edit `jobs.json` directly** (no browser needed) |
| Markdown Workspace | **Fully reproduced** (SOUL.md, USER.md, memory/, etc.) |
| Session management + memory | **Fully reproduced** (daily/idle reset, JSONL history) |
| Delivery queue + retry | **Fully reproduced** (atomic write, dead-letter) |

### Gateway-free — fully browserless

**Not needed:**
- Gateway server (persistent process)
- Web UI / browser / login sessions
- Webhook server (standalone)

**Required:**
- Environment where `claude -p` works (Claude Code CLI installed)
- Node.js 22+
- Telegram Bot Token (only if sending)
- OS scheduler (systemd / LaunchAgent etc., for always-on operation)

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

## Reproduced OpenClaw Features

| OpenClaw feature | What it does | openclaw-cc reproduction |
|---|---|---|
| **Markdown Workspace** | Define agent personality/principles in SOUL.md etc. | `workspace/*.md` + `workspace-loader.js`. Converted to XML tags and injected into systemPrompt |
| **Memory System** | Accumulate daily logs + long-term memory in Markdown | `memory-manager.js`. Daily: `memory/YYYY-MM-DD.md`, long-term: `MEMORY.md` |
| **Session-type Profiles** | Load different files for DM/cron/group | 3 profiles: main/cron/group. Group skips personal info files |
| **NO_REPLY Suppression** | "Stay silent when nothing to report" — prevent noise | `cron-scheduler.js` checks output. Empty or "NO_REPLY" → skip delivery |
| **Cron Scheduler** | Run agents autonomously on schedule | `every` (ms interval) / `at` (one-shot) implemented. Cron expressions planned for Phase 3 |
| **Deterministic Stagger** | Offset concurrent jobs to avoid thundering herd | `MD5(jobId) % staggerMs` — same offset survives restarts |
| **Delivery Queue** | Retry on failure, dead-letter management | Atomic write + O_EXCL for crash resistance. bestEffort (partial success) supported |
| **Session Management** | Create, reset, archive sessions | daily (time-crossing) + idle (24h) reset policies |
| **Agent Loop** | Call AI model with session continuity | Three-tier: CLI session / JSONL fallback / Stateless |
| **Telegram Adapter** | Send + receive via channel | Direct Bot API + Long Polling for bidirectional communication (no Gateway). Group topics + DM supported |
| **Cost-aware Model Routing** | Select Haiku/Sonnet/Opus by task difficulty | `payload.model` per job |
| **Gateway** | Channel auth + message routing | **Not needed** — direct Bot API sendMessage |

### Cost-aware Model Routing (Haiku / Sonnet / Opus)

Specify `payload.model` per job to select the appropriate model for each task:

```
haiku  → Health checks, notification summaries, YES/NO decisions (low cost)
sonnet → Standard reply drafts, daily reports (balanced)
opus   → Complex decisions, estimates, client projects (highest quality)
```

Like OpenClaw, rather than running all jobs on the best model, **optimize cost by routing based on difficulty**.
See [`examples/jobs.example.md`](examples/jobs.example.md) for details.

### Not Yet Reproduced

| Feature | Status |
|---------|--------|
| Cron expressions (`0 9 * * *`) | Planned for Phase 3 |
| Session Compaction (summarize old history) | Planned for Phase 3 |
| Model Failover (automatic model switching) | Planned for Phase 3 |
| Webhook receiver | Long Polling implemented. Webhook planned for Phase 3 |
| Additional channels (Slack, Discord) | Planned for Phase 3 |

## Quick Start

### 1. Setup

```bash
git clone <repo-url>
cd openclaw-cc
cp .env.example .env
cp config/default.example.json config/default.json
```

### 2. Create a Telegram Bot

1. Use [@BotFather](https://t.me/BotFather) → `/newbot` → get Bot Token
2. Add to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   ```
3. Edit `config/default.json`:
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

> **How to find your Chat ID**: Add your bot to a group, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to see the `chat.id`.

### 3. Configure Cron Jobs

```bash
mkdir -p data/cron
cp examples/jobs.example.json data/cron/jobs.json
```

Edit `jobs.json` to set your Telegram destination:
```json
{
  "delivery": {
    "channel": "telegram",
    "to": "-1001234567890:topic:6"
  }
}
```

> **Note**: Currently only `kind: "every"` and `kind: "at"` are supported. Cron expressions (`kind: "cron"`) are planned for Phase 3. Unknown kinds are logged as warnings and skipped.

### 4. Set Up Workspace (Markdown Memory)

```bash
cp workspace/USER.example.md workspace/USER.md
cp workspace/MEMORY.example.md workspace/MEMORY.md
cp workspace/GROUP_MEMORY.example.md workspace/GROUP_MEMORY.md
```

Edit `workspace/USER.md` to set your profile (recommended but not required).

### 5. Run

```bash
node src/index.js
```

On startup:
1. Loads `.env` and `config/default.json`
2. Scans Delivery Queue for pending items (crash recovery)
3. Starts Telegram Poller (only when `allowedChatIds` is set — Long Polling)
4. Cron Scheduler schedules all jobs
5. Rescans Delivery Queue every 30 seconds
6. Graceful shutdown on `SIGTERM`/`SIGINT`

> **Note**: If `allowedChatIds` is empty or unset, Telegram reception is disabled (send-only mode).

## Cron Jobs

### Job Types

| kind | Behavior | Example |
|------|----------|---------|
| `every` | Repeat at ms interval | Health check every 5 minutes |
| `at` | Run once at fixed time | "Send greeting tomorrow at 9 AM" |
| `cron` | Cron expression (Phase 3) | `"0 9 * * *"` |

### Execution Flow

```
1. CronScheduler schedules job via setTimeout
2. Time reached → SessionManager resolves session
3. AgentRunner executes claude -p
   - Workspace Context auto-injected into systemPrompt
   - Only files matching sessionType are loaded
4. Output is "NO_REPLY" → skip delivery (means "nothing to report")
5. Output present → enqueue to DeliveryQueue
6. DeliveryQueue → Telegram Adapter → Bot API send
```

### NO_REPLY Pattern

When the agent returns `NO_REPLY`, delivery is skipped.
This prevents unnecessary notifications when nothing needs attention:

```
message: "Check system health. If everything is normal, reply with exactly NO_REPLY."
```

### Stagger (Execution Offset)

Prevents multiple jobs with the same interval from firing simultaneously:
```
delay = MD5(jobId) % staggerMs
```
Deterministic algorithm — same offset reproduces even after restarts.

## Markdown Memory System

Reproduces OpenClaw's most distinctive feature.
Agent "personality", "memory", and "skills" are managed in **Markdown files**.

### Workspace File Structure

```
workspace/
├── SOUL.md              ← Agent behavior principles (loaded in all sessions)
├── USER.md              ← User profile (loaded in main/group)
├── IDENTITY.md          ← Agent name, type, character
├── TOOLS.md             ← Available tools/API list
├── AGENTS.md            ← Session startup procedure, memory management rules
├── HEARTBEAT.md         ← Health check checklist
├── BOOTSTRAP.md         ← First-run onboarding (delete after use)
├── MEMORY.md            ← Long-term memory (main session only)
├── GROUP_MEMORY.md      ← Group shared memory (no personal info)
└── memory/
    ├── 2026-03-01.md    ← Today's daily log
    └── 2026-02-28.md    ← Yesterday's log (today + yesterday auto-loaded)
```

### Session Type Load Control

Specify `sessionType` at execution to control which files are loaded:

| sessionType | Files loaded | Use case |
|-------------|-------------|----------|
| **main** (default) | SOUL, USER, IDENTITY, AGENTS, TOOLS, MEMORY, daily memory, BOOTSTRAP | Normal DM conversation |
| **cron** | SOUL, IDENTITY, AGENTS | Scheduled jobs (lightweight, saves tokens) |
| **group** | SOUL, USER, IDENTITY, AGENTS, GROUP_MEMORY, daily memory | Group chat (skips MEMORY.md = personal data protection) |

> **Safe by default**: When sessionType is unspecified, defaults to `"main"` (full load). Even if forgotten, it never fails due to missing information.

### Context Injection

Before Agent Runner calls `claude -p`, Workspace Loader reads Markdown files and **auto-injects them as XML tags at the start of systemPrompt**:

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

(original systemPrompt continues here)
```

### Token Budget Management

When context exceeds `maxContextChars` (default 8000 chars), lower-priority items are automatically trimmed:

| Priority | Files | Reason |
|----------|-------|--------|
| 1 (keep) | SOUL, USER, BOOTSTRAP | Essential for agent behavior |
| 2 (medium) | IDENTITY, TOOLS, daily memory | Useful but not critical |
| 3 (trim last) | MEMORY, GROUP_MEMORY | Tend to grow large |

### Memory Manager

Handles daily and long-term memory file management:

```javascript
import { MemoryManager } from "./src/memory-manager.js";

const mm = new MemoryManager({ workspacePath: "./workspace" });
await mm.init();

// Append to daily log → workspace/memory/2026-03-01.md
await mm.appendDaily({
  title: "Heartbeat check",
  body: "All systems normal. CPU 23%, memory 45%."
});

// Append to long-term memory → workspace/MEMORY.md
await mm.appendLongTerm({
  title: "Server restart pattern",
  body: "Server tends to need restart on Mondays after batch processing."
});

// Delete daily logs older than 30 days
await mm.pruneOldDaily();
```

## Telegram Integration

### Prerequisites

- Telegram Bot Token obtained (created via @BotFather)
- Bot added to group

### Bidirectional Model

openclaw-cc's Telegram integration is **bidirectional**:

```
Send (Cron → notification):
  Cron Job → Agent Runner → Delivery Queue → Telegram Adapter → sendMessage

Receive (User → Bot):
  getUpdates (Long Polling) → TelegramPoller → Agent Runner → sendMessage reply
```

On receive, the agent runs in **Stateless mode** (`--no-session-persistence`).
This ensures stable operation across continuous messages without session corruption.

Safety limits are automatically applied:
- `--allowedTools Bash,Read,Write,Edit,Grep,Glob` — tool restrictions
- `--max-budget-usd 0.50` — cost cap (configurable)

To enable reception, set `allowedChatIds` in `config/default.json`:

```json
{
  "telegram": {
    "allowedChatIds": ["-1001234567890", "123456789"],
    "pollingIntervalMs": 3000
  }
}
```

**allowedChatIds format:**
```
"-1001234567890"              → Entire group (all topics allowed)
"-1001234567890:topic:6"      → Only specific topic within group
"123456789"                   → DM (personal chat)
```

If `allowedChatIds` is empty, reception stays disabled (send-only mode).

### Destination Format

OpenClaw-compatible `"to"` format:
```
"-1001234567890"              → Send to group
"-1001234567890:topic:6"      → Send to topic 6 within group
```

### 4096-Character Chunking

Telegram's per-message limit is 4096 characters. Long messages are automatically split, preferring line breaks.

## Requirements

- **Node.js 22+** (uses `node:test`, `crypto.randomUUID()`, native `fetch`)
- **Claude Code CLI** (`claude` command available in PATH)
- **Zero runtime dependencies** — everything uses Node.js standard library

> **Note on `.env` parsing**: Built-in parser supports `KEY=VALUE` format only.
> `export KEY=VALUE` is not supported. Single/double quotes around values are stripped.
> Existing environment variables are never overwritten.

## Key Design Decisions

### Three-Tier Agent Runner

Automatically selects from 3 execution modes based on use case:

- **Mode 1 (CLI session)**: `claude -p --session-id UUID` — Claude Code manages sessions automatically. Ideal for continuous cron job execution
- **Mode 2 (JSONL fallback)**: Self-managed `{sessionId}.jsonl` with prompt injection — fallback when Mode 1 is unavailable
- **Mode 3 (Stateless)**: `claude -p --no-session-persistence` — fresh session each time. Used for chat messages (Telegram reception)

Mode 1/2 auto-detected on first run with result cached. Mode 3 is explicitly selected via `noSessionPersistence: true`.

### Crash Resistance

- **Atomic write**: `.tmp` + `rename` pattern — no file corruption even on mid-process crash
- **File lock**: `.lock` + O_EXCL — exclusive access (stale locks auto-released by TTL)
- **Processing flag**: `.processing` file prevents double processing (configurable stale detection)
- **Memory writes**: All append operations use `withLock()` for exclusive access

### Personal Data Protection (for OSS)

`workspace/USER.md`, `workspace/MEMORY.md`, `workspace/GROUP_MEMORY.md` are **gitignored**.
Only templates (`.example.md`) are tracked in the repository:

```
workspace/USER.example.md      ← git-tracked (template)
workspace/USER.md              ← .gitignore (user copies and edits)
```

Personal data won't leak to public repositories even with `git add .`.

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

### BUNSHIN — Business AI Partner

`examples/bunshin/` contains a template set for building an autonomous business AI partner with openclaw-cc.

Features:
- **Japanese language** — workspace files written in Japanese
- **Business-focused** — client management, project management, team management templates
- **Context-driven design** — "know everything and act proactively" instead of "react to messages"
- **CronJob samples** — morning briefing + hourly proactive checks

Details: [`examples/bunshin/README.md`](examples/bunshin/README.md)

### Dev Assistant — Development AI Partner

`examples/dev-assistant/` contains a template set for building a development-focused AI assistant with openclaw-cc.

Features:
- **English-based** — for international teams and English projects
- **Development-focused** — Git status, PR, CI, test failure monitoring and summaries
- **Approval-first** — Read → Propose → Approve → Execute → Verify safety loop
- **CronJob samples** — daily dev briefing (extensions: PR reminders, test monitoring)

Details: [`examples/dev-assistant/README.md`](examples/dev-assistant/README.md)

## License

MIT
