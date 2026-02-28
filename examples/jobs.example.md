# jobs.example.json — OpenClaw-compatible Job Format

`data/cron/jobs.json` に配置するジョブ定義の説明です。

## フィールド一覧

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | string | ジョブ一意 ID（stagger hash にも使用） |
| `agentId` | string | エージェント ID（セッション分離に使用） |
| `name` | string | 人間向けの表示名 |
| `enabled` | boolean | `false` でスキップ |
| `schedule.kind` | `"every"` / `"at"` | 繰り返し or 1回実行（`"cron"` は Phase 3） |
| `schedule.every` | number | 繰り返し間隔（ms） |
| `schedule.at` | string | ISO 8601 実行時刻 |
| `schedule.staggerMs` | number | 同時刻ジョブのズラし幅（ms） |
| `sessionTarget` | string | `"isolated"` = ジョブ専用セッション |
| `payload.kind` | `"agentTurn"` | 現在は agentTurn のみ |
| `payload.model` | string | AI モデル（下記 **Cost-aware Model Routing** 参照） |
| `payload.message` | string | エージェントに渡すプロンプト |
| `payload.timeoutSeconds` | number | タイムアウト（秒） |
| `payload.systemPrompt` | string | カスタム systemPrompt（任意） |
| `payload.workspacePath` | string | Workspace ディレクトリ（任意） |
| `delivery.mode` | `"announce"` | 配信モード |
| `delivery.channel` | string | `"telegram"` 等 |
| `delivery.to` | string | 宛先（`"-100...:topic:6"` 形式） |
| `delivery.bestEffort` | boolean | `true` = 部分送信を許可 |
| `deleteAfterRun` | boolean | `true` = 実行後にジョブを自動削除（`kind: "at"` 用） |

## Cost-aware Model Routing

`payload.model` でジョブごとにモデルを使い分けます:

| model | コスト | 用途の例 |
|-------|--------|---------|
| `haiku` | 低 | ヘルスチェック、通知要約、YES/NO 判定 |
| `sonnet` | 中 | 定型返信の下書き、日次レポート |
| `opus` | 高 | 複雑な判断、クライアント対応、見積もり |

OpenClaw と同様に、ジョブの難易度に応じてモデルを選ぶことでコストを最適化できます。

## NO_REPLY パターン

`message` に「異常がなければ `NO_REPLY` と返せ」と指示すると、
エージェントが `NO_REPLY` を返した場合は配信がスキップされます。
通知疲れを防ぐ OpenClaw のコアパターンです。
