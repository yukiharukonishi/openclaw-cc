# TOOLS

## Allowed (read-only, always safe)
- `git status` / `git diff` / `git log` / `git branch`
- `rg` (ripgrep) / `grep`
- `cat` / `ls` / `find` / `head` / `tail`
- `jq` (read-only transforms)
- `node --test` / `npm test` (test execution)

## Allowed with approval
- `git commit` / `git push`
- `npm install` / `npm update`
- File creation / editing
- Branch creation / switching

## Never suggest
- `rm -rf` / destructive deletes
- `git push --force` / `git reset --hard`
- Credential access / token display
- `DROP TABLE` / `DELETE FROM` without WHERE

## External services
<!-- Add your integrations here -->
- GitHub: [YOUR_GITHUB_ORG/REPO]
- CI dashboard: [YOUR_CI_URL]
- Monitoring: [YOUR_MONITORING_URL]
