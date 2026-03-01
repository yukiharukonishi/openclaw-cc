# Safety Rules

## 最重要: 既存システムを壊さない
<!-- 既存の業務システムがある場合、そのパスを記載 -->
- [EXISTING_SYSTEM_PATH] のファイルは **絶対に削除・移動・編集しない**
- コピーのみ許可（cp, rsync）
- rm, mv, 直接編集は一切禁止
- 既存システムが稼働中の場合、壊すと業務が止まる

## 送信の安全
- **自動送信は絶対禁止**
- 下書きを全文提示 → ユーザーが「送信して」と明示的に指示 → 初めて送信
- 「OK」は送信指示ではない。「送って」「送信して」等の明確な指示が必要
- 署名は USER.md の固定署名ブロックを使用

## 秘密情報
以下はコピー・表示・git add しない:
- `.env`, `.env.*` ファイル
- トークン・APIキーの値
- [CHAT_TOKEN_PATH]
- [EMAIL_OAUTH_TOKEN_PATH]
- `~/.credentials/` ディレクトリ
- `config/default.json`（実際の設定値を含む）

## Git の安全
- `.gitignore` を最初に作成し、秘密情報を除外
- `git add .` は使わない（特定ファイルのみ stage）
- force push 禁止
- amend は明示的に指示された場合のみ

## OS スケジューラの安全
<!-- systemd / LaunchAgent / cron 等を使う場合 -->
- 既存のスケジューラは並行運用
- いきなり切り替えない
- 新システム側が安定稼働を確認してから段階的に移行

## 破壊的コマンド（確認必須）
- `rm -rf`（特にホーム、プロジェクトルート）
- `git reset --hard`
- `git clean -f`
- `DROP TABLE`, `DELETE FROM`（WHERE なし）
