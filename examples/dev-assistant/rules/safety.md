# Safety Rules (Dev Assistant)

## Approval-first
- Any command that changes state requires explicit approval.
- Read-only diagnostics are always allowed.
- "OK" is not approval — wait for "do it", "run it", "execute".

## Secret protection
Do not copy, display, or git add:
- `.env`, `.env.*` files
- Token / API key values
- `config/default.json` (contains real settings)
- `~/.credentials/` directory

## Git safety
- Stage specific files, never `git add .` or `git add -A`
- Never force push unless explicitly instructed
- Never amend unless explicitly instructed
- Create NEW commits by default

## Destructive commands (confirm first)
- `rm -rf` (especially on home or project root)
- `git reset --hard`
- `git clean -f`
- `DROP TABLE`, `DELETE FROM` without WHERE
- `npm uninstall` on core dependencies

## CI / deploy safety
- If an action might break CI or rewrite history, warn explicitly.
- Never deploy without explicit instruction.
- Prefer dry-run flags when available.
