// Binance先物の過去スナップショットを 30分足から復元して永続化する（任意・1回だけ実行）
//   node scripts/backfill-binance-30m.js --days 120 --top 300
//   24h出来高 = 直近48本(30分足)の quoteVolume 合計。ライブ保存が始まった時刻より前だけを埋める。
//   環境変数 PERSIST_URL / PERSIST_AUTH_TOKEN は server.js と同じ（本番に入れるなら Turso を指定）
const axios = require('axios');
const persist = require('../persist');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []).filter(x => x.length));
const DAYS = Number(args.days || 120);
const TOP = Number(args.top ?? 300);          // 0 = 全銘柄
const EXCHANGE = 'binance-futures';
const api = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function klines(symbol, startMs, endMs) {
  const out = [];
  let start = startMs;
  for (let i = 0; i < 20; i++) {
    let res;
    try {
      res = await api.get('/fapi/v1/klines', { params: { symbol, interval: '30m', startTime: start, endTime: endMs, limit: 1500 } });
    } catch (err) {
      if ([418, 429].includes(err.response?.status)) { console.log('  ⏳ レート制限、60秒待機'); await sleep(60000); continue; }
      throw err;
    }
    await sleep(300); // 重み10/回 → 2,400/分の制限内
    out.push(...res.data);
    if (res.data.length < 1500) break;
    start = res.data[res.data.length - 1][6] + 1;
  }
  return out;
}

function jstLabel(ms) {
  const d = new Date(ms + 9 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

(async () => {
  if (!(await persist.init())) throw new Error('永続化が初期化できません');
  const live = await persist.listSnapshots(EXCHANGE, { fromTs: 0, toTs: Date.now(), limit: 5000 });
  const firstLive = live.filter(s => s.source === 'live').map(s => s.ts).sort((a, b) => a - b)[0];
  const endMs = Math.floor((firstLive || Date.now()) / 1800000) * 1800000;   // ライブ開始前の30分境界まで
  const startMs = endMs - DAYS * 86400000 - 86400000;                          // 24h分の助走を足す
  console.log(`📥 対象期間 ${new Date(startMs).toISOString()} 〜 ${new Date(endMs).toISOString()} (ライブ開始: ${firstLive ? new Date(firstLive).toISOString() : 'なし'})`);

  const info = await api.get('/fapi/v1/exchangeInfo');
  const symbols = info.data.symbols.filter(s => s.status === 'TRADING' && s.symbol.endsWith('USDT')).map(s => s.symbol);
  console.log(`🪙 ${symbols.length} 銘柄の30分足を取得します（約${Math.ceil(symbols.length * Math.ceil(DAYS * 48 / 1500) * 0.35 / 60)}分）`);

  const SLOTS = Math.ceil((endMs - startMs) / 1800000) + 2;
  const slot = ms => Math.round((ms - startMs) / 1800000);
  const bars = new Map(); // symbol -> { qv: Float64Array, close: Float64Array }  (NaN = データなし)
  for (const [i, sym] of symbols.entries()) {
    try {
      const k = await klines(sym, startMs, endMs);
      const qv = new Float64Array(SLOTS).fill(NaN), close = new Float64Array(SLOTS).fill(NaN);
      for (const x of k) { const j = slot(x[0]); if (j >= 0 && j < SLOTS) { qv[j] = Number(x[7]); close[j] = Number(x[4]); } }
      bars.set(sym, { qv, close });
    } catch (err) {
      console.error(`  ❌ ${sym}: ${err.message}`);
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${symbols.length}`);
  }

  let saved = 0;
  for (let t = startMs + 86400000; t < endMs; t += 1800000) {   // t = スナップショット時刻(=この時点までの24h)
    const rows = [];
    const jEnd = slot(t);                       // t 直前の足 = jEnd-1 … 24h前 = jEnd-48
    for (const [sym, m] of bars) {
      let sum = 0, n = 0, close = null;
      for (let j = jEnd - 1; j >= jEnd - 48 && j >= 0; j--) {
        const v = m.qv[j];
        if (Number.isNaN(v)) continue;
        sum += v; n++;
        if (close === null) close = m.close[j];
      }
      const c24 = jEnd - 49 >= 0 ? m.close[jEnd - 49] : NaN;
      if (n >= 40 && sum > 0) rows.push({ symbol: sym, quoteVolume: sum, lastPrice: close, priceChangePercent: Number.isNaN(c24) ? null : (close / c24 - 1) * 100 });
    }
    rows.sort((a, b) => b.quoteVolume - a.quoteVolume);
    const top = TOP > 0 ? rows.slice(0, TOP) : rows;
    if (!top.length) continue;
    const id = await persist.saveSnapshot({ exchangeId: EXCHANGE, timestamp: t, timeLabel: jstLabel(t), rows: top, source: 'backfill' });
    if (id) saved++;
    if (saved % 200 === 0 && saved) console.log(`  💾 ${saved} スナップショット保存 (${new Date(t).toISOString()})`);
  }
  console.log(`✅ 完了: ${saved} スナップショットを保存`, persist.getStatus());
})().catch(err => { console.error('❌ backfill 失敗:', err.message); process.exit(1); });
