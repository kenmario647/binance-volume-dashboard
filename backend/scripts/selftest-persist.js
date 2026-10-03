// persist.js の自己テスト（一時ファイルDBで保存→読み出しを確認）
//   node scripts/selftest-persist.js
const os = require('os');
const path = require('path');
process.env.PERSIST_URL = 'file:' + path.join(os.tmpdir(), `volume-selftest-${process.pid}.db`);
const persist = require('../persist');

(async () => {
  const ok = await persist.init();
  if (!ok) throw new Error('init failed');
  const rows = [
    { symbol: 'BTCUSDT', quoteVolume: 13.6e9, lastPrice: 84500, priceChangePercent: 1.2 },
    { symbol: 'ETHUSDT', quoteVolume: 9.5e9, lastPrice: 3800, priceChangePercent: -0.4 },
    { symbol: 'QNTUSDT', quoteVolume: 1.2e9, lastPrice: 165, priceChangePercent: 55.2 },
  ];
  const t0 = Date.parse('2026-10-03T00:00:00Z');
  const id1 = await persist.saveSnapshot({ exchangeId: 'binance-futures', timestamp: t0, timeLabel: '09:00', rows });
  const dup = await persist.saveSnapshot({ exchangeId: 'binance-futures', timestamp: t0, timeLabel: '09:00', rows });
  const id2 = await persist.saveSnapshot({ exchangeId: 'binance-futures', timestamp: t0 + 1800000, timeLabel: '09:30', rows: [rows[2], rows[0], rows[1]], source: 'fallback' });
  const hist = await persist.getSymbolHistory('binance-futures', 'QNTUSDT', { fromTs: t0 - 1, toTs: t0 + 3600000 });
  const snaps = await persist.listSnapshots('binance-futures', { fromTs: 0, toTs: t0 + 3600000 });
  const at = await persist.getSnapshotAt('binance-futures', t0 + 1000, { top: 2 });
  const stats = await persist.getStats();
  console.log(JSON.stringify({ id1, dupIgnored: dup === null, id2, qntHistory: hist, snapshots: snaps.length, atTop2: at.rankings.map(r => `${r.symbol}#${r.rank}`), stats, status: persist.getStatus() }, null, 1));
  const assert = require('assert');
  assert.strictEqual(dup, null, '同一時刻の二重保存が防げていない');
  assert.strictEqual(hist.length, 2, 'QNTの履歴が2点であるべき');
  assert.deepStrictEqual(hist.map(h => h.rank), [3, 1], 'QNTの順位推移 3→1');
  assert.deepStrictEqual(at.rankings.map(r => r.symbol), ['BTCUSDT', 'ETHUSDT']);
  console.log('✅ selftest OK');
})().catch(err => { console.error('❌ selftest FAILED:', err); process.exit(1); });
