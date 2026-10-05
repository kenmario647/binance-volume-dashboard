// ════════════════════════════════════════════════════
// 急上昇の監視と通知
//   5分ごとに Binance先物(暗号資産の無期限)の全銘柄の価格を1回取得し、15分前と比べる。
//   15分で ALERT_THRESHOLD_PCT 以上上がったら Bark / ntfy に通知する。
//   判定条件は 95日・528銘柄の検定で決めたもの(+12%・同じ銘柄は4時間止める・直前60分は不成立)。
// ════════════════════════════════════════════════════

const axios = require('axios');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const clean = v => String(v || '').replace(/[^\x21-\x7E]/g, '');

function envNum(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function defaultConfig() {
  return {
    disabled: process.env.MOMENTUM_DISABLED === '1',
    thresholdPct: envNum('ALERT_THRESHOLD_PCT', 12),
    pauseMin: envNum('ALERT_PAUSE_MIN', 240),
    // 直前60分に一度でも条件を満たしていたら鳴らさない(1回の上昇につき1回)
    quietMin: 60,
    minQuoteVolume: envNum('ALERT_MIN_QUOTE_VOLUME', 500000),
    windowMin: 15,
    stepMin: 5,
    keepMin: 80,
    trackMin: 240,
    topN: 30,
    notifyOnStart: process.env.MOMENTUM_NOTIFY_ON_START !== '0',
  };
}

const pct = (now, before) => (now / before - 1) * 100;
const signed = v => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const fmtPrice = p => Number(p).toLocaleString('en-US', { maximumSignificantDigits: 5, useGrouping: false });
function fmtVol(v) {
  if (!Number.isFinite(v)) return '-';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

// targetTs に最も近い価格(±tolMs 以内)。points は [ts, price] の古い順
function priceAt(points, targetTs, tolMs = 150000) {
  let best = null;
  let bestDiff = Infinity;
  for (let i = points.length - 1; i >= 0; i--) {
    const d = Math.abs(points[i][0] - targetTs);
    if (d < bestDiff) {
      bestDiff = d;
      best = points[i][1];
    }
    if (points[i][0] < targetTs - tolMs) break;
  }
  return bestDiff <= tolMs ? best : null;
}

// ── 通知(Bark / ntfy・無料) ──
function createNotifier({ log = console } = {}) {
  let barkKey = clean(process.env.BARK_KEY);
  let barkServer = clean(process.env.BARK_SERVER) || 'https://api.day.app';
  // Bark アプリに表示される URL(https://api.day.app/キー/…)をそのまま貼っても使えるようにする
  const m = barkKey.match(/^(https?:\/\/[^/]+)\/([A-Za-z0-9]{8,64})/);
  if (m) {
    barkKey = m[2];
    if (!clean(process.env.BARK_SERVER)) barkServer = m[1];
  }
  const bark = /^[A-Za-z0-9]{8,64}$/.test(barkKey) ? { key: barkKey, server: barkServer.replace(/\/+$/, '') } : null;
  const topic = clean(process.env.NTFY_TOPIC);
  const ntfy = /^[-_A-Za-z0-9]{1,64}$/.test(topic)
    ? { topic, server: (clean(process.env.NTFY_SERVER) || 'https://ntfy.sh').replace(/\/+$/, '') }
    : null;
  if (process.env.BARK_KEY && !bark) log.warn('⚠️ BARK_KEY の形式が正しくありません(Bark アプリに表示される URL を貼ってください)');
  if (process.env.NTFY_TOPIC && !ntfy) log.warn('⚠️ NTFY_TOPIC は半角英数字と - _ の64文字以内で指定してください');

  const level = clean(process.env.BARK_LEVEL) || 'active';
  const priority = envNum('NTFY_PRIORITY', 4);
  const st = { sent: 0, errors: 0, lastError: null };
  const secrets = [bark?.key, ntfy?.topic].filter(s => s && s.length >= 4);
  const redact = msg => secrets.reduce((t, s) => t.split(s).join('***'), String(msg || '')).slice(0, 300);

  function fail(channel, err) {
    st.errors += 1;
    st.lastError = `${new Date().toISOString()} ${channel}: ${redact(err.message)}`;
    log.error(`❌ ${channel} 通知に失敗:`, redact(err.message));
  }

  async function send({ title, body, url, group = 'pump' }) {
    const ok = [];
    if (bark) {
      try {
        const r = await axios.post(`${bark.server}/push`, { device_key: bark.key, title, body, url, group, level }, { timeout: 10000 });
        if (r.data?.code !== 200) throw new Error(`code=${r.data?.code} ${r.data?.message || ''}`);
        ok.push('bark');
      } catch (err) {
        fail('Bark', err);
      }
    }
    if (ntfy) {
      try {
        const r = await axios.post(ntfy.server, { topic: ntfy.topic, title, message: body, click: url, tags: ['rocket'], priority }, { timeout: 10000 });
        if (!r.data?.id) throw new Error('応答に id がありません');
        ok.push('ntfy');
      } catch (err) {
        fail('ntfy', err);
      }
    }
    if (ok.length) st.sent += 1;
    return ok;
  }

  return { send, configured: !!(bark || ntfy), status: () => ({ bark: !!bark, ntfy: !!ntfy, ...st }) };
}

function createMomentum({ api, persist, notifier, config, log = console } = {}) {
  const cfg = { ...defaultConfig(), ...(config || {}) };
  const notify = notifier || createNotifier({ log });
  const prices = new Map(); // symbol -> [[ts, price], ...]
  const meta = new Map(); // symbol -> { quoteVolume, change24h }
  const lastCondTs = new Map();
  const lastAlertTs = new Map();
  let universe = new Set();
  let universeAt = 0;
  let alerts = []; // 直近24時間(古い順)
  let view = { ts: null, items: [], eligible: 0 };
  let timer = null;
  const status = { enabled: !cfg.disabled, ready: false, lastRunAt: null, lastError: null, symbols: 0, backfilledSymbols: 0, alertsSent: 0 };

  function push(symbol, ts, price) {
    if (!(price > 0)) return;
    let pts = prices.get(symbol);
    if (!pts) prices.set(symbol, (pts = []));
    if (pts.length && pts[pts.length - 1][0] >= ts) return;
    pts.push([ts, price]);
  }

  function prune(now) {
    const cut = now - cfg.keepMin * MIN;
    for (const [s, pts] of prices) {
      let i = 0;
      while (i < pts.length && pts[i][0] < cut) i++;
      if (i) pts.splice(0, i);
      if (!pts.length || !universe.has(s)) prices.delete(s);
    }
    alerts = alerts.filter(a => now - a.ts <= DAY);
  }

  // 暗号資産の無期限先物だけ(株トークン TRADIFI_PERPETUAL は除く)。上場1日未満も除く
  async function refreshUniverse() {
    const { data } = await api.get('/fapi/v1/exchangeInfo');
    const now = Date.now();
    const next = new Set();
    for (const s of data.symbols || []) {
      if (s.status !== 'TRADING' || s.quoteAsset !== 'USDT' || s.contractType !== 'PERPETUAL') continue;
      if (s.onboardDate && now - Number(s.onboardDate) < DAY) continue;
      next.add(s.symbol);
    }
    if (next.size) {
      universe = next;
      universeAt = now;
      status.symbols = next.size;
    }
  }

  function ingest(ts, rows) {
    for (const r of rows) {
      if (!universe.has(r.symbol)) continue;
      push(r.symbol, ts, r.price);
      meta.set(r.symbol, { quoteVolume: r.quoteVolume, change24h: r.change24h });
    }
    prune(ts);
  }

  async function snapshot() {
    const { data } = await api.get('/fapi/v1/ticker/24hr');
    const ts = Date.now();
    ingest(ts, data.map(t => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      quoteVolume: parseFloat(t.quoteVolume),
      change24h: parseFloat(t.priceChangePercent),
    })));
    return ts;
  }

  function evaluate(ts) {
    const items = [];
    for (const [symbol, pts] of prices) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== ts) continue;
      const m = meta.get(symbol);
      if (!m || !(m.quoteVolume >= cfg.minQuoteVolume)) continue;
      const p15 = priceAt(pts, ts - cfg.windowMin * MIN);
      if (!p15) continue;
      const p5 = priceAt(pts, ts - 5 * MIN);
      const p60 = priceAt(pts, ts - 60 * MIN);
      items.push({
        symbol, price: last[1], pct15: pct(last[1], p15),
        pct5: p5 ? pct(last[1], p5) : null, pct60: p60 ? pct(last[1], p60) : null,
        change24h: m.change24h, quoteVolume: m.quoteVolume,
      });
    }
    items.sort((a, b) => b.pct15 - a.pct15);
    items.forEach((it, i) => { it.rank = i + 1; });

    const fired = [];
    for (const it of items) {
      if (it.pct15 < cfg.thresholdPct) break;
      const lastCond = lastCondTs.get(it.symbol) ?? -Infinity;
      const lastAlert = lastAlertTs.get(it.symbol) ?? -Infinity;
      if (ts - lastCond > cfg.quietMin * MIN && ts - lastAlert > cfg.pauseMin * MIN) {
        fired.push(it);
        lastAlertTs.set(it.symbol, ts);
      }
      lastCondTs.set(it.symbol, ts);
    }
    return { items, fired };
  }

  function message(a) {
    const base = a.symbol.replace(/USDT$/, '');
    const lines = [
      `価格 ${fmtPrice(a.price)} ／ 24h ${signed(a.change24h)} ／ 出来高 ${fmtVol(a.quoteVolume)}`,
      `15分上昇率 ${a.rank}位` + (a.pct60 != null ? ` ／ 60分 ${signed(a.pct60)}` : ''),
    ];
    return { title: `🚀 ${base} 15分で${signed(a.pct15)}`, body: lines.join('\n'), url: `https://www.binance.com/ja/futures/${a.symbol}` };
  }

  async function handleAlert(it, ts) {
    const a = {
      id: null, ts, symbol: it.symbol, pct15: it.pct15, pct60: it.pct60, price: it.price, change24h: it.change24h,
      quoteVolume: it.quoteVolume, rank: it.rank, thresholdPct: cfg.thresholdPct, maxPrice: it.price, notified: '',
    };
    alerts.push(a);
    a.notified = (await notify.send(message(a))).join(',');
    a.id = (await persist?.saveMomentumAlert?.(a)) ?? null;
    status.alertsSent += 1;
    log.log(`🚀 [急上昇] ${a.symbol} 15分 ${signed(a.pct15)} 価格 ${fmtPrice(a.price)} 通知先: ${a.notified || 'なし'}`);
  }

  // 通知後4時間の最高値を追う(「その後どこまで伸びたか」の答え合わせ用)
  function trackFollowUp(ts) {
    for (const a of alerts) {
      if (ts - a.ts > cfg.trackMin * MIN) continue;
      const pts = prices.get(a.symbol);
      const last = pts?.[pts.length - 1];
      if (!last || last[0] !== ts || !(last[1] > a.maxPrice)) continue;
      a.maxPrice = last[1];
      persist?.updateMomentumAlertMax?.(a.id, a.maxPrice);
    }
  }

  async function runRound() {
    if (!universe.size || Date.now() - universeAt > HOUR) {
      try {
        await refreshUniverse();
      } catch (err) {
        log.error('❌ [急上昇] 銘柄一覧の取得に失敗:', err.message);
      }
    }
    return processRound(await snapshot());
  }

  async function processRound(ts) {
    const { items, fired } = evaluate(ts);
    view = { ts, items: items.slice(0, cfg.topN), eligible: items.length };
    trackFollowUp(ts);
    for (const it of fired) await handleAlert(it, ts);
    status.lastRunAt = new Date(ts).toISOString();
    status.ready = true;
    status.lastError = null;
    return { items, fired };
  }

  // 起動時に直近80分の1分足を取り込む。再起動直後から15分前と比べられ、重複通知も防げる
  async function backfill() {
    const symbols = [...universe];
    const end = Date.now();
    let idx = 0;
    const worker = async () => {
      while (idx < symbols.length) {
        const s = symbols[idx++];
        try {
          const { data } = await api.get('/fapi/v1/klines', { params: { symbol: s, interval: '1m', limit: cfg.keepMin } });
          for (const k of data) {
            const closeTs = Number(k[0]) + MIN;
            if (closeTs <= end) push(s, closeTs, parseFloat(k[4]));
          }
          status.backfilledSymbols += 1;
        } catch (err) {
          const st = err.response?.status;
          if (st === 429 || st === 418) {
            idx = symbols.length;
            log.warn('⚠️ [急上昇] API制限のため起動時の取り込みを中断');
          }
        }
        await new Promise(r => setTimeout(r, 40));
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  // 取り込んだ1分足から「直前60分に条件を満たした時刻」を復元する(起動直後の重複通知を防ぐ)
  function prime() {
    const step = cfg.stepMin * MIN;
    for (const [s, pts] of prices) {
      if (pts.length < 2) continue;
      const last = pts[pts.length - 1][0];
      for (let t = Math.floor(last / step) * step; t > last - cfg.quietMin * MIN; t -= step) {
        const p = priceAt(pts, t, 90000);
        const b = priceAt(pts, t - cfg.windowMin * MIN, 90000);
        if (p && b && pct(p, b) >= cfg.thresholdPct) {
          lastCondTs.set(s, t);
          break;
        }
      }
    }
  }

  async function restoreAlerts() {
    if (!persist?.listMomentumAlerts) return;
    try {
      const rows = await persist.listMomentumAlerts({ fromTs: Date.now() - DAY, limit: 1000 });
      alerts = rows.slice().reverse();
      for (const a of alerts) lastAlertTs.set(a.symbol, Math.max(lastAlertTs.get(a.symbol) ?? -Infinity, a.ts));
    } catch (err) {
      log.error('❌ [急上昇] 過去の通知の読み込みに失敗:', err.message);
    }
  }

  function schedule() {
    const step = cfg.stepMin * MIN;
    const now = Date.now();
    const next = Math.floor(now / step) * step + step + 5000; // 5分刻み + 5秒(30分ごとの取得と重ならないよう少しずらす)
    timer = setTimeout(async () => {
      try {
        await runRound();
      } catch (err) {
        status.lastError = `${new Date().toISOString()} ${err.message}`;
        log.error('❌ [急上昇] 取得エラー:', err.message);
      }
      schedule();
    }, next - now);
  }

  async function start() {
    if (cfg.disabled) {
      log.log('🚀 [急上昇] 無効 (MOMENTUM_DISABLED=1)');
      return;
    }
    const n = notify.status();
    const pauseText = cfg.pauseMin % 60 === 0 ? `${cfg.pauseMin / 60}時間` : `${cfg.pauseMin}分`;
    log.log(`🚀 [急上昇] 開始: 15分で+${cfg.thresholdPct}%以上・同じ銘柄は${pauseText}停止・通知先 Bark=${n.bark ? '有' : '無'} ntfy=${n.ntfy ? '有' : '無'}`);
    try {
      await refreshUniverse();
    } catch (err) {
      status.lastError = `${new Date().toISOString()} ${err.message}`;
      log.error('❌ [急上昇] 銘柄一覧の取得に失敗:', err.message);
    }
    await backfill();
    await restoreAlerts();
    prime();
    log.log(`🚀 [急上昇] 起動時の取り込み: ${status.backfilledSymbols}/${universe.size}銘柄`);
    try {
      await runRound();
    } catch (err) {
      status.lastError = `${new Date().toISOString()} ${err.message}`;
      log.error('❌ [急上昇] 取得エラー:', err.message);
    }
    schedule();
    if (cfg.notifyOnStart && notify.configured) {
      await notify.send({ title: '🚀 急上昇通知を開始しました', body: `15分で+${cfg.thresholdPct}%以上で通知 ／ 同じ銘柄は${pauseText}止めます`, group: 'system' });
    }
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function withGain(a) {
    return { ...a, maxGainPct: a.maxPrice ? pct(a.maxPrice, a.price) : null };
  }

  function getView() {
    const n = notify.status();
    return {
      enabled: !cfg.disabled,
      ready: status.ready,
      updatedAt: view.ts,
      config: { thresholdPct: cfg.thresholdPct, pauseMin: cfg.pauseMin, windowMin: cfg.windowMin, stepMin: cfg.stepMin, minQuoteVolume: cfg.minQuoteVolume },
      notify: { bark: n.bark, ntfy: n.ntfy },
      eligible: view.eligible,
      items: view.items,
      alerts: alerts.slice().reverse().map(withGain),
    };
  }

  async function getAlertHistory(fromTs) {
    if (persist?.getStatus?.().ready) return (await persist.listMomentumAlerts({ fromTs, limit: 2000 })).map(withGain);
    return alerts.filter(a => a.ts >= fromTs).reverse().map(withGain);
  }

  function getStatus() {
    return { ...status, notify: notify.status() };
  }

  return {
    start, stop, getView, getStatus, getAlertHistory,
    _test: {
      prime, push,
      setUniverse: list => { universe = new Set(list); },
      round: async (ts, rows) => { ingest(ts, rows); return processRound(ts); },
    },
  };
}

module.exports = { createMomentum, createNotifier, priceAt };
