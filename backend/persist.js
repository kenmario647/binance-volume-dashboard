// ════════════════════════════════════════════════════
// 永続化: スナップショットを SQLite(libsql) に保存する
//   - PERSIST_URL が libsql://… なら Turso(クラウド)、file:… ならローカルファイル
//   - 未設定時は file:./data/volume.db（Render ではデプロイで消えるので本番は Turso を設定する）
//   - 失敗しても UI(メモリ上のデータ)は止めない。状態は /api/health の persistence で確認できる
// ════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const DEFAULT_URL = 'file:' + path.join(__dirname, 'data', 'volume.db');
// 環境変数は前後の空白・改行を除く（ダッシュボードに貼った値に改行が混ざるとヘッダが不正になる）
const url = (process.env.PERSIST_URL || DEFAULT_URL).trim();
const authToken = (process.env.PERSIST_AUTH_TOKEN || '').trim() || undefined;

// エラー文にトークンが含まれても外に出さない（/api/health で状態を公開しているため）
function redact(msg) {
  let text = String(msg || '');
  for (const secret of [authToken, process.env.PERSIST_AUTH_TOKEN]) {
    if (secret && secret.length > 8) text = text.split(secret).join('***');
  }
  return text.replace(/Bearer\s+\S+/g, 'Bearer ***').slice(0, 300);
}
const disabled = process.env.PERSIST_DISABLED === '1';

const status = {
  enabled: !disabled,
  mode: url.startsWith('file:') ? 'local-file' : 'remote',
  target: url.startsWith('file:') ? url : url.replace(/\/\/([^.]+)\./, '//***.'), // ホスト名の先頭だけ伏せる
  ready: false,
  snapshotsWritten: 0,
  rowsWritten: 0,
  lastWriteAt: null,
  lastError: null,
};

let client = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     exchange TEXT NOT NULL,
     ts INTEGER NOT NULL,
     time_label TEXT,
     source TEXT NOT NULL DEFAULT 'live',
     symbol_count INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_snapshots_exchange_ts ON snapshots(exchange, ts)`,
  `CREATE TABLE IF NOT EXISTS ranks (
     snapshot_id INTEGER NOT NULL,
     symbol TEXT NOT NULL,
     rank INTEGER NOT NULL,
     quote_volume REAL NOT NULL,
     last_price REAL,
     change_pct REAL,
     PRIMARY KEY (snapshot_id, symbol)
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_ranks_symbol ON ranks(symbol, snapshot_id)`,
];

async function init() {
  if (disabled) {
    console.log('💾 永続化: 無効 (PERSIST_DISABLED=1)');
    return false;
  }
  try {
    if (url.startsWith('file:')) {
      fs.mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true });
    }
    client = createClient({ url, authToken });
    for (const sql of SCHEMA) await client.execute(sql);
    status.ready = true;
    status.lastError = null;
    console.log(`💾 永続化: 準備完了 (${status.mode}: ${status.target})`);
    if (status.mode === 'local-file' && process.env.NODE_ENV === 'production') {
      console.warn('⚠️ 永続化先がローカルファイルです。Render では再デプロイで消えるので PERSIST_URL に Turso を設定してください');
    }
    return true;
  } catch (err) {
    status.ready = false;
    status.lastError = `${new Date().toISOString()} init: ${redact(err.message)}`;
    console.error('❌ 永続化の初期化に失敗:', redact(err.message));
    return false;
  }
}

// rows: [{ symbol, quoteVolume, lastPrice, priceChangePercent }, ...]  出来高降順で渡す(順位 = index+1)
async function saveSnapshot({ exchangeId, timestamp, timeLabel, rows, source = 'live' }) {
  if (!status.ready || !rows?.length) return null;
  try {
    const ins = await client.execute({
      sql: `INSERT OR IGNORE INTO snapshots (exchange, ts, time_label, source, symbol_count) VALUES (?, ?, ?, ?, ?)`,
      args: [exchangeId, timestamp, timeLabel || null, source, rows.length],
    });
    if (ins.rowsAffected === 0) return null; // 同じ時刻のスナップショットは二重保存しない
    const snapshotId = Number(ins.lastInsertRowid);
    // 100行ずつの複数行INSERTにまとめる(リモートDBへの往復回数を減らす)
    const CHUNK = 100;
    const stmts = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const args = [];
      chunk.forEach((r, j) => args.push(snapshotId, r.symbol, i + j + 1, Number(r.quoteVolume) || 0, numOrNull(r.lastPrice), numOrNull(r.priceChangePercent)));
      stmts.push({
        sql: `INSERT OR REPLACE INTO ranks (snapshot_id, symbol, rank, quote_volume, last_price, change_pct) VALUES ` + chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', '),
        args,
      });
    }
    await client.batch(stmts, 'write');
    status.snapshotsWritten += 1;
    status.rowsWritten += rows.length;
    status.lastWriteAt = new Date().toISOString();
    status.lastError = null;
    return snapshotId;
  } catch (err) {
    status.lastError = `${new Date().toISOString()} save(${exchangeId}): ${redact(err.message)}`;
    console.error(`❌ 永続化に失敗 [${exchangeId}]:`, redact(err.message));
    return null;
  }
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── 読み出し ──

// 銘柄1つの順位・出来高の時系列
async function getSymbolHistory(exchangeId, symbol, { fromTs, toTs, limit = 2000 } = {}) {
  if (!status.ready) return [];
  const res = await client.execute({
    sql: `SELECT s.ts, s.time_label, s.source, r.rank, r.quote_volume, r.last_price, r.change_pct
            FROM ranks r JOIN snapshots s ON s.id = r.snapshot_id
           WHERE s.exchange = ? AND r.symbol = ? AND s.ts >= ? AND s.ts <= ?
           ORDER BY s.ts ASC LIMIT ?`,
    args: [exchangeId, symbol, fromTs ?? 0, toTs ?? Date.now(), limit],
  });
  return res.rows.map(r => ({
    ts: Number(r.ts), time: r.time_label, source: r.source, rank: Number(r.rank),
    volume: Number(r.quote_volume), price: r.last_price == null ? null : Number(r.last_price),
    change: r.change_pct == null ? null : Number(r.change_pct),
  }));
}

// スナップショットの一覧(メタ情報のみ)
async function listSnapshots(exchangeId, { fromTs, toTs, limit = 500 } = {}) {
  if (!status.ready) return [];
  const res = await client.execute({
    sql: `SELECT id, ts, time_label, source, symbol_count FROM snapshots
           WHERE exchange = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`,
    args: [exchangeId, fromTs ?? 0, toTs ?? Date.now(), limit],
  });
  return res.rows.map(r => ({ id: Number(r.id), ts: Number(r.ts), time: r.time_label, source: r.source, symbolCount: Number(r.symbol_count) }));
}

// 指定時刻以前で最も近いスナップショットの順位表
async function getSnapshotAt(exchangeId, ts, { top = 100 } = {}) {
  if (!status.ready) return null;
  const snap = await client.execute({
    sql: `SELECT id, ts, time_label, source FROM snapshots WHERE exchange = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
    args: [exchangeId, ts],
  });
  if (!snap.rows.length) return null;
  const s = snap.rows[0];
  const rows = await client.execute({
    sql: `SELECT symbol, rank, quote_volume, last_price, change_pct FROM ranks WHERE snapshot_id = ? ORDER BY rank ASC LIMIT ?`,
    args: [s.id, top],
  });
  return {
    ts: Number(s.ts), time: s.time_label, source: s.source,
    rankings: rows.rows.map(r => ({ symbol: r.symbol, rank: Number(r.rank), volume: Number(r.quote_volume),
      price: r.last_price == null ? null : Number(r.last_price), change: r.change_pct == null ? null : Number(r.change_pct) })),
  };
}

async function getStats() {
  if (!status.ready) return null;
  const res = await client.execute(
    `SELECT exchange, COUNT(*) AS snapshots, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM snapshots GROUP BY exchange ORDER BY exchange`
  );
  return res.rows.map(r => ({ exchange: r.exchange, snapshots: Number(r.snapshots),
    first: new Date(Number(r.first_ts)).toISOString(), last: new Date(Number(r.last_ts)).toISOString() }));
}

function getStatus() {
  return { ...status };
}

module.exports = { init, saveSnapshot, getSymbolHistory, listSnapshots, getSnapshotAt, getStats, getStatus, redact };
