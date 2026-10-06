// momentum.js の自己テスト（合成データで通知の判定条件を確認。ネットワークには出ない）
//   node scripts/selftest-momentum.js
const assert = require('assert');
const http = require('http');
const { createMomentum, createNotifier, priceAt } = require('../momentum');

const MIN = 60000;
const quiet = { log() {}, warn() {}, error() {} };
const sent = [];
const saved = [];
const notifier = { configured: true, status: () => ({ bark: true, ntfy: false }), send: async m => { sent.push(m); return ['bark']; } };
const persist = {
  saveMomentumAlert: async a => { saved.push({ ...a }); return saved.length; },
  updateMomentumAlertMax: async () => {},
  listMomentumAlerts: async () => [],
  getStatus: () => ({ ready: false }),
};
const config = { thresholdPct: 12, pauseMin: 240, notifyOnStart: false };
const t0 = Date.parse('2026-10-03T12:00:00Z');
const at = k => t0 + k * 5 * MIN;

(async () => {
  // ── 1) 通知の条件: 初回だけ鳴る・直前60分の継続中は鳴らない・同じ銘柄は4時間止める ──
  const m = createMomentum({ persist, notifier, config, log: quiet });
  m._test.setUniverse(['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'EEEUSDT']);
  const aaa = k => (k <= 12 ? 1.0 : k === 13 ? 1.13 : k === 14 ? 1.14 : k <= 30 ? 1.15 : k <= 61 ? 1.32 : 1.5);
  const log = {};
  for (let k = 0; k <= 64; k++) {
    const rows = [
      { symbol: 'AAAUSDT', price: aaa(k), quoteVolume: 5e6, change24h: 1 },
      { symbol: 'BBBUSDT', price: k >= 20 ? 1.119 : 1.0, quoteVolume: 5e6, change24h: 0 },
      { symbol: 'CCCUSDT', price: k >= 20 ? 1.3 : 1.0, quoteVolume: 1e5, change24h: 0 },
    ];
    if (k !== 17) rows.push({ symbol: 'EEEUSDT', price: k >= 20 ? 1.5 : 1.0, quoteVolume: 5e6, change24h: 0 });
    const { items, fired } = await m._test.round(at(k), rows);
    log[k] = { fired: fired.map(f => f.symbol), syms: items.map(i => i.symbol) };
  }
  const firedAt = Object.entries(log).filter(([, v]) => v.fired.length).map(([k, v]) => `${k}:${v.fired.join('+')}`);
  console.log('通知が出たステップ:', firedAt.join(', '));
  assert.deepStrictEqual(firedAt, ['13:AAAUSDT', '21:EEEUSDT', '62:AAAUSDT'], 'AAAは初回(k=13)と4時間後の再上昇(k=62)だけ。EEEは15分前の価格が揃った k=21 で検知');
  assert.ok(!log[20].syms.includes('CCCUSDT'), '24h出来高$0.5M未満は対象外');
  assert.ok(!log[20].syms.includes('EEEUSDT'), '15分前の価格が無い銘柄は判定しない');
  assert.ok(log[20].syms.includes('BBBUSDT') && !log[20].fired.includes('BBBUSDT'), '+11.9%は通知しない');
  assert.strictEqual(saved.length, 3, '通知は3件記録');
  assert.strictEqual(saved[0].rank, 1);
  assert.ok(Math.abs(saved[0].pct15 - 13) < 1e-9, '15分の上昇率 +13%');
  console.log('通知の例:', JSON.stringify(sent[0]));
  assert.ok(sent[0].title.includes('AAA') && sent[0].title.includes('+13.0%'));
  assert.ok(sent[0].url.endsWith('/futures/AAAUSDT'));
  const v = m.getView();
  assert.strictEqual(v.alerts.length, 3);
  assert.ok(Math.abs(v.alerts[2].maxGainPct - (1.32 / 1.13 - 1) * 100) < 1e-9, '1回目の通知後4時間以内の最高値(1.32)を追跡し、4時間を過ぎた1.5は含めない');

  // ── 2) 再起動時: 直前60分に条件を満たしていた銘柄は鳴らさない、今まさに上がり始めた銘柄は鳴らす ──
  const m2 = createMomentum({ persist, notifier, config, log: quiet });
  m2._test.setUniverse(['FFFUSDT', 'GGGUSDT']);
  const now = at(100);
  for (let i = 80; i >= 1; i--) {
    const ts = now - i * MIN;
    m2._test.push('FFFUSDT', ts, i > 40 ? 1.0 : 1.0 + (40 - i) * 0.0125); // 40分前から上昇中
    m2._test.push('GGGUSDT', ts, 1.0);                                     // 今まで横ばい
  }
  m2._test.prime();
  const r2 = await m2._test.round(now, [
    { symbol: 'FFFUSDT', price: 1.5, quoteVolume: 5e6, change24h: 50 },
    { symbol: 'GGGUSDT', price: 1.14, quoteVolume: 5e6, change24h: 14 },
  ]);
  console.log('再起動直後の通知:', r2.fired.map(f => f.symbol).join(', '));
  assert.deepStrictEqual(r2.fired.map(f => f.symbol), ['GGGUSDT']);

  // ── 3) 価格の突き合わせ: ±150秒以内の最寄りの価格を使う ──
  const pts = [[t0, 1], [t0 + 5 * MIN, 2], [t0 + 10 * MIN, 3]];
  assert.strictEqual(priceAt(pts, t0 + 5 * MIN + 2000), 2);
  assert.strictEqual(priceAt([[t0, 1], [t0 + 10 * MIN, 3]], t0 + 5 * MIN), null, '取得が1回欠けて10分空いた時刻は判定しない');

  // ── 4) 通知の再試行: 一時的な失敗は送り直し、設定の誤り(4xx)は送り直さない ──
  let hits = 0;
  let mode = 'flaky';
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits += 1;
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'flaky' && hits < 3) { res.statusCode = 503; return res.end('{"error":"busy"}'); }
      if (mode === 'bad') { res.statusCode = 400; return res.end('{"error":"invalid topic"}'); }
      res.end('{"id":"ok1","event":"message"}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.NTFY_TOPIC = 'selftest-topic';
  process.env.NTFY_SERVER = `http://127.0.0.1:${srv.address().port}`;
  const nf = createNotifier({ log: quiet, retryDelays: [0, 20, 40] });
  const ok1 = await nf.send({ title: 't', body: 'b', url: 'https://example.com' });
  assert.deepStrictEqual(ok1, ['ntfy'], '2回失敗しても3回目で届く');
  assert.strictEqual(hits, 3);
  hits = 0; mode = 'bad';
  const ok2 = await nf.send({ title: 't', body: 'b' });
  assert.deepStrictEqual(ok2, [], '400 は失敗として返す');
  assert.strictEqual(hits, 1, '設定の誤り(4xx)は送り直さない');
  srv.close();
  // 繋がらない宛先でもエラーの中身が空にならない
  process.env.NTFY_SERVER = 'http://localhost:9';
  const nf2 = createNotifier({ log: quiet, retryDelays: [0] });
  await nf2.send({ title: 't', body: 'b' });
  console.log('接続できない時の記録:', nf2.status().lastError);
  assert.ok(/ECONNREFUSED/.test(nf2.status().lastError), '接続エラーのコードが残る');
  delete process.env.NTFY_TOPIC; delete process.env.NTFY_SERVER;

  // ── 5) 届かなかった通知は次の回から再送し、30分で打ち切る ──
  let calls = 0;
  const outbox = [];
  const flakyNotifier = { configured: true, status: () => ({ bark: false, ntfy: true }),
    send: async msg => { calls += 1; outbox.push(msg.title); return calls === 1 ? [] : ['ntfy']; } };
  const updates = [];
  const m3 = createMomentum({ persist: { ...persist, updateMomentumAlertNotified: async (id, n) => updates.push([id, n]) }, notifier: flakyNotifier, config, log: quiet });
  m3._test.setUniverse(['HHHUSDT']);
  for (let k = 0; k <= 5; k++) {
    await m3._test.round(at(k), [{ symbol: 'HHHUSDT', price: k >= 5 ? 1.2 : 1.0, quoteVolume: 5e6, change24h: 20 }]);
  }
  assert.strictEqual(m3.getStatus().pendingResend, 1, '1回目の送信に失敗した通知は再送待ちになる');
  await m3._test.round(at(6), [{ symbol: 'HHHUSDT', price: 1.2, quoteVolume: 5e6, change24h: 20 }]);
  console.log('再送の件名:', outbox[1]);
  assert.ok(outbox[1].startsWith('（再送）🚀 HHH'), '次の回に（再送）として届く');
  assert.strictEqual(m3.getStatus().pendingResend, 0);
  assert.ok(m3.getView().alerts[0].notified.includes('(再送)'));
  assert.strictEqual(updates.length, 1, '記録も「再送で届いた」に更新');
  const m4 = createMomentum({ persist, notifier: { configured: true, status: () => ({}), send: async () => [] }, config, log: quiet });
  m4._test.setUniverse(['JJJUSDT']);
  for (let k = 0; k <= 5; k++) await m4._test.round(at(k), [{ symbol: 'JJJUSDT', price: k >= 5 ? 1.2 : 1.0, quoteVolume: 5e6, change24h: 20 }]);
  for (let k = 6; k <= 12; k++) await m4._test.round(at(k), [{ symbol: 'JJJUSDT', price: 1.2, quoteVolume: 5e6, change24h: 20 }]);
  assert.strictEqual(m4.getStatus().pendingResend, 0, '30分を過ぎたら再送を打ち切る');
  console.log('✅ selftest OK');
})().catch(err => { console.error('❌ selftest FAILED:', err.message); process.exit(1); });
