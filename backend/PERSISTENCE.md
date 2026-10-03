# スナップショットの永久保存

30分ごとのスナップショット（取引所ごとの出来高順位表）を SQLite(libsql) に保存します。
メモリ上の11本（UI用）はそのまま。保存に失敗しても UI は止まりません。

## 保存先の指定（環境変数）

| 変数 | 値 | 用途 |
|---|---|---|
| `PERSIST_URL` | `libsql://<db>-<org>.turso.io` | 本番（Turso・無料枠）。**Render では必ず設定**（未設定だとローカルファイル＝再デプロイで消える） |
| | `file:./data/volume.db`（既定） | ローカル開発・Mac での実行 |
| `PERSIST_AUTH_TOKEN` | Turso のトークン | `PERSIST_URL` が libsql:// のとき必須 |
| `PERSIST_DISABLED` | `1` | 保存を止めたいとき |

### Turso の準備（5分）
1. https://turso.tech でアカウント作成 → Database を作成（リージョンは Render と同じ Oregon/`aws-us-west-2` が速い）
2. Database の **URL**（`libsql://...`）と **Token**（Create Token）を控える
3. Render → Service → Environment に `PERSIST_URL` と `PERSIST_AUTH_TOKEN` を追加 → 再デプロイ

## 保存内容

- `snapshots`: exchange / ts(ミリ秒UTC) / time_label(JST HH:MM) / source(`live` | `fallback` | `backfill`) / symbol_count
- `ranks`: snapshot_id / symbol / rank / quote_volume / last_price / change_pct
- Binance先物は **全USDT無期限（約520銘柄）** を保存（UIはTOP100のまま）。他取引所はTOP100
- `fallback` = 取引所APIが落ちて前回データを再利用したスナップショット（分析では除外推奨）
- 1日あたり約 4取引所 × 48回、Binance先物は520行/回 → 年1GB未満

## 履歴API

```
GET /api/history/stats                                    保存状況（取引所別の件数・期間）
GET /api/history/:exchange/symbol/:symbol?days=7          銘柄の順位・出来高の時系列
GET /api/history/:exchange/snapshots?days=2               スナップショット一覧
GET /api/history/:exchange/at?ts=2026-10-01T00:00:00Z&top=100   その時刻の順位表
```
`:exchange` = `binance-futures` | `bitget-spot` | `upbit-spot` | `binance-alpha`。`/api/health` の `persistence` で接続状態と最終書き込み時刻を確認できます。

## 過去分の復元（任意・Binance先物のみ）

ライブ保存が始まる前の期間を、Binance の30分足から復元できます（24h出来高＝直近48本の合計）。

```bash
cd backend
PERSIST_URL=libsql://... PERSIST_AUTH_TOKEN=... node scripts/backfill-binance-30m.js --days 120 --top 300
```
約520銘柄×120日の取得で10分前後（Binanceのレート制限内で動くよう0.3秒間隔）。ライブ保存の開始時刻より前だけを埋め、同じ時刻は二重保存しません。

## 動作確認

```bash
cd backend && node scripts/selftest-persist.js     # 一時DBで保存→読み出し
```
