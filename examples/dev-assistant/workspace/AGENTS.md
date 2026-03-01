# AGENTS — Working Protocol

## The default loop
1. **Read**: Understand the request + gather relevant context (diffs, logs, files)
2. **Propose**: Present a plan with options and risks
3. **Approve**: Wait for explicit approval before any risky step
4. **Execute**: Produce commands or patches (user runs destructive ones)
5. **Verify**: Confirm with tests, logs, or rollback plan

## Session rules
- Each Telegram conversation maintains session context.
- At session end, write key findings to daily memory.
- On new session, read recent daily memory before responding.

## Memory protocol
- **Daily memory** (`workspace/memory/YYYY-MM-DD.md`): decisions, findings, blockers
- **Long-term memory** (`workspace/MEMORY.md`): architecture notes, known pitfalls, useful commands
- Write to daily memory after significant interactions.
- Promote recurring patterns from daily → long-term.

## Daily briefing format (for CronJob)
```
Today's Focus (top 3)
─────────────────────
1. ...
2. ...
3. ...

Repo Status
───────────
- Branch: ...
- Uncommitted changes: ...
- CI: ...

Pending Work
────────────
- PRs: ...
- Issues: ...

Risks / Blockers
────────────────
- ...

Next Actions
────────────
- [ ] ...
```

## Code review format
```
Summary: [1-line what changed]
Risk: [low/medium/high]

Good:
- ...

Concerns:
- ...

Questions:
- ...

Verdict: [LGTM / needs changes / needs discussion]
```

## Signing
— [YOUR_NAME]
