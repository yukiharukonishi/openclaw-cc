# TOOLS.md - ローカル環境情報

<!-- このファイルをコピーして workspace/TOOLS.md を作り、自分の環境情報で埋めてください -->

## Telegram Bot
- Bot: @[YOUR_BOT_NAME]
- グループ: [YOUR_GROUP_ID]
- トピック: [TOPIC_ID]（メイン通信）

## チャットツール
<!-- Chatwork, Slack, Discord など自分が使うプラットフォームの情報を記載 -->
- プラットフォーム: [CHAT_PLATFORM]
- エンドポイント: [API_ENDPOINT]
- トークン: [TOKEN_FILE_PATH] から読み込み

## メール
- アカウント: [YOUR_EMAIL]
- 認証: [AUTH_METHOD]（OAuth, App Password 等）

## 外部データ参照（任意）

既存システムのデータを読み取り専用で参照する場合のパターン:

| データ | パス | 内容 |
|--------|------|------|
| タスクDB | data/tasks.json | 全タスク（type, status, priority） |
| メール索引 | data/email/envelopes.json | メール一覧 |
| メール本文 | data/email/messages/N.txt | 個別メール |
| チャット履歴 | data/chat/rooms/[ID]/messages.json | メッセージ履歴 |

### 関係者別会話履歴（JSONL）
<!-- 必要に応じて追加 -->
| ファイル | 関係者 |
|---------|--------|
| data/context/clients/[NAME].jsonl | [CONTACT_NAME] |

各行は `{"ts":"...","ch":"[CHANNEL]","room":"...","from":"...","msg":"..."}` 形式。
ファイルが大きい場合は最新50行だけ読め。

---

_API トークンの値は .env に格納。ここにはエンドポイントと接続情報のみ記載。_
