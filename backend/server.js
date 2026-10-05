const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const persist = require('./persist');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════
// 共通ユーティリティ
// ════════════════════════════════════════════════════

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

async function fetchWithRetry(axiosInstance, url, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.log(`  ⏳ リトライ ${attempt + 1}/${maxRetries} (${Math.round(delay / 1000)}秒待機)...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      return await axiosInstance.get(url);
    } catch (error) {
      const status = error.response?.status;
      const code = error.code || 'UNKNOWN';
      console.error(`❌ API失敗 (${attempt + 1}/${maxRetries}): ${url} - status=${status || 'N/A'} code=${code}`);
      if (status && status >= 400 && status < 500 && status !== 418 && status !== 429 && status !== 403) throw error;
      if (attempt === maxRetries - 1) throw error;
    }
  }
}

function getJSTTimeLabel() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════
// データストア
// 各取引所の「最新データ」+「スナップショット履歴」を保持
// 取引所APIは起動時と30分刻み(XX:00, XX:30)のみ叩く。それ以外はメモリのデータを返す
// ════════════════════════════════════════════════════

const MAX_SNAPSHOTS = 11;

// { 'binance-futures': { current: { data: [...], timestamp }, snapshots: [ { time, rankings } ] } }
const store = {};

function saveExchangeData(exchangeId, data, fullData) {
  if (!data?.length) return;

  const timeLabel = getJSTTimeLabel();
  const now = Date.now();
  const rankings = {};
  data.forEach((item, index) => {
    rankings[item.symbol] = { rank: index + 1, volume: item.quoteVolume };
  });

  if (!store[exchangeId]) store[exchangeId] = { current: null, snapshots: [] };

  // 最新データを保存
  store[exchangeId].current = { data, timestamp: now };

  // スナップショットを追加
  store[exchangeId].snapshots.push({ time: timeLabel, timestamp: now, rankings });
  while (store[exchangeId].snapshots.length > MAX_SNAPSHOTS) {
    store[exchangeId].snapshots.shift();
  }

  console.log(`📸 [${exchangeId}] データ保存: ${timeLabel} (スナップショット ${store[exchangeId].snapshots.length}件)`);

  // 永続化（全銘柄があればそれを、無ければTOP100を保存）。失敗してもメモリ上のデータは生きる
  persist.saveSnapshot({ exchangeId, timestamp: now, timeLabel, rows: fullData || data, source: 'live' })
    .catch(err => console.error(`❌ 永続化エラー [${exchangeId}]:`, err.message));
}

// API失敗時に前回データでスナップショットだけ保存する
function saveSnapshotFallback(exchangeId) {
  const s = store[exchangeId];
  if (!s?.current?.data?.length) return false;

  const timeLabel = getJSTTimeLabel();
  const rankings = {};
  s.current.data.forEach((item, index) => {
    rankings[item.symbol] = { rank: index + 1, volume: item.quoteVolume };
  });

  const now = Date.now();
  s.snapshots.push({ time: timeLabel, timestamp: now, rankings });
  while (s.snapshots.length > MAX_SNAPSHOTS) {
    s.snapshots.shift();
  }

  console.log(`⚠️ [${exchangeId}] フォールバック: 前回データでスナップショット保存 ${timeLabel} (計${s.snapshots.length}件)`);
  persist.saveSnapshot({ exchangeId, timestamp: now, timeLabel, rows: s.current.data, source: 'fallback' })
    .catch(err => console.error(`❌ 永続化エラー [${exchangeId}]:`, err.message));
  return true;
}

function getExchangeData(exchangeId) {
  const s = store[exchangeId];
  if (!s || !s.current) return null;
  return {
    data: s.current.data,
    timestamp: s.current.timestamp,
    snapshots: s.snapshots,
  };
}

// ════════════════════════════════════════════════════
// 1. Binance 先物
// ════════════════════════════════════════════════════

const binanceApi = axios.create({
  baseURL: 'https://fapi.binance.com',
  timeout: 30000,
  headers: DEFAULT_HEADERS,
});

const momentum = require('./momentum').createMomentum({ api: binanceApi, persist });

let activeSymbolsSet = null;

async function fetchBinanceActiveSymbols() {
  try {
    const response = await fetchWithRetry(binanceApi, '/fapi/v1/exchangeInfo');
    activeSymbolsSet = new Set(
      response.data.symbols
        .filter(s => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
        .map(s => s.symbol)
    );
    return activeSymbolsSet;
  } catch (error) {
    return activeSymbolsSet;
  }
}

async function fetchBinanceFutures() {
  try {
    const tradingSymbols = await fetchBinanceActiveSymbols();
    await new Promise(resolve => setTimeout(resolve, 500));
    const tickerResponse = await fetchWithRetry(binanceApi, '/fapi/v1/ticker/24hr');
    const sortedAll = tickerResponse.data
      .filter(t => {
        if (!t.symbol.endsWith('USDT')) return false;
        return tradingSymbols ? tradingSymbols.has(t.symbol) : true;
      })
      .map(t => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        priceChangePercent: parseFloat(t.priceChangePercent),
        quoteVolume: parseFloat(t.quoteVolume),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
    const sorted = sortedAll.slice(0, 100);

    saveExchangeData('binance-futures', sorted, sortedAll);
    console.log(`✅ [Binance先物] ${sorted.length}銘柄取得`);
  } catch (error) {
    console.error(`[Binance先物] エラー: ${error.message} (code=${error.code || 'N/A'}, status=${error.response?.status || 'N/A'})`);
    saveSnapshotFallback('binance-futures');
  }
}

// ════════════════════════════════════════════════════
// 2. Bitget 現物
// ════════════════════════════════════════════════════

const bitgetApi = axios.create({
  baseURL: 'https://api.bitget.com',
  timeout: 15000,
  headers: DEFAULT_HEADERS,
});

async function fetchBitgetSpot() {
  try {
    const response = await fetchWithRetry(bitgetApi, '/api/v2/spot/market/tickers');
    const sorted = response.data.data
      .filter(t => t.symbol.endsWith('USDT'))
      .map(t => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPr || 0),
        priceChangePercent: parseFloat(t.change24h || 0) * 100,
        quoteVolume: parseFloat(t.usdtVolume || t.quoteVolume || 0),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    saveExchangeData('bitget-spot', sorted);
    console.log(`✅ [Bitget現物] ${sorted.length}銘柄取得`);
  } catch (error) {
    console.error('[Bitget現物] エラー:', error.message);
  }
}

// ════════════════════════════════════════════════════
// 3. Upbit 現物 (USD換算)
// ════════════════════════════════════════════════════

const upbitApi = axios.create({
  baseURL: 'https://api.upbit.com',
  timeout: 15000,
  headers: DEFAULT_HEADERS,
});

let upbitMarketsList = null;

async function fetchUpbitMarkets() {
  try {
    const response = await fetchWithRetry(upbitApi, '/v1/market/all?is_details=false');
    upbitMarketsList = response.data
      .filter(m => m.market.startsWith('KRW-'))
      .map(m => ({ market: m.market }));
    return upbitMarketsList;
  } catch (error) {
    return upbitMarketsList || [];
  }
}

async function fetchUpbitSpot() {
  try {
    const markets = await fetchUpbitMarkets();
    if (!markets.length) throw new Error('マーケット一覧が取得できません');
    const marketCodes = markets.map(m => m.market).join(',');
    const response = await fetchWithRetry(upbitApi, `/v1/ticker?markets=${marketCodes}`);
    const tickers = response.data;

    let krwToUsd = 1 / 1450;
    const usdtTicker = tickers.find(t => t.market === 'KRW-USDT');
    if (usdtTicker && usdtTicker.trade_price) {
      krwToUsd = 1 / parseFloat(usdtTicker.trade_price);
    }

    const sorted = tickers
      .filter(t => t.market !== 'KRW-USDT')
      .map(t => {
        const base = t.market.replace('KRW-', '');
        const priceKrw = parseFloat(t.trade_price || 0);
        const volumeKrw = parseFloat(t.acc_trade_price_24h || 0);
        return {
          symbol: `${base}USDT`,
          displayName: base,
          lastPrice: priceKrw * krwToUsd,
          priceChangePercent: parseFloat(t.signed_change_rate || 0) * 100,
          quoteVolume: volumeKrw * krwToUsd,
        };
      })
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    saveExchangeData('upbit-spot', sorted);
    console.log(`✅ [Upbit現物] ${sorted.length}銘柄取得 (USD換算)`);
  } catch (error) {
    console.error('[Upbit現物] エラー:', error.message);
  }
}

// ════════════════════════════════════════════════════
// 4. Binance Alpha 先物
// ════════════════════════════════════════════════════

const binanceAlphaApiBase = axios.create({
  baseURL: 'https://www.binance.com',
  timeout: 15000,
  headers: DEFAULT_HEADERS,
});

let alphaTokenList = null;

async function fetchAlphaTokenList() {
  try {
    const response = await fetchWithRetry(
      binanceAlphaApiBase,
      '/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list'
    );
    alphaTokenList = response.data.data || [];
    return alphaTokenList;
  } catch (error) {
    return alphaTokenList || [];
  }
}

async function fetchBinanceAlpha() {
  try {
    const alphaTokens = await fetchAlphaTokenList();
    if (!alphaTokens.length) throw new Error('Alphaトークンリストが取得できません');

    // Alphaトークンリスト自身に volume24h / price / percentChange24h が入っているのでそれを直接使う
    // (以前は Binance先物 /fapi/v1/ticker/24hr とクロス参照していたため Binance先物と同じ出来高になっていた)
    const sorted = alphaTokens
      .filter(t => !t.offline && t.volume24h && parseFloat(t.volume24h) > 0)
      .map(t => ({
        symbol: (t.symbol || '').toUpperCase() + 'USDT',
        displayName: (t.symbol || '').toUpperCase(),
        lastPrice: parseFloat(t.price || 0),
        priceChangePercent: parseFloat(t.percentChange24h || 0),
        quoteVolume: parseFloat(t.volume24h || 0),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    saveExchangeData('binance-alpha', sorted);
    console.log(`✅ [Alpha] ${sorted.length}銘柄取得 (Alpha専用出来高)`);
  } catch (error) {
    console.error(`[Alpha] エラー: ${error.message} (code=${error.code || 'N/A'}, status=${error.response?.status || 'N/A'})`);
    saveSnapshotFallback('binance-alpha');
  }
}

// ════════════════════════════════════════════════════
// 全取引所のデータ一括取得（起動時+正時に呼ぶ）
// ════════════════════════════════════════════════════

async function fetchAllExchanges() {
  const timeLabel = getJSTTimeLabel();
  console.log(`\n🔄 [${timeLabel}] 全取引所データ取得開始...`);

  // 順番に取得（レートリミット回避）
  await fetchBinanceFutures();
  await new Promise(r => setTimeout(r, 1000));
  await fetchBitgetSpot();
  await new Promise(r => setTimeout(r, 1000));
  await fetchUpbitSpot();
  await new Promise(r => setTimeout(r, 1000));
  await fetchBinanceAlpha();

  console.log(`✅ [${timeLabel}] 全取引所データ取得完了\n`);
}

// ════════════════════════════════════════════════════
// 30分スケジューラ（毎時 00 分・30 分にデータ取得）
// ════════════════════════════════════════════════════

function scheduleNextHalfHourlyFetch() {
  const now = new Date();
  // 次の30分刻み（XX:00 または XX:30）までのミリ秒を計算（2秒バッファで確実に超える）
  const minutesUntilNext = 30 - (now.getMinutes() % 30);
  const msUntilNext =
    minutesUntilNext * 60000 -
    now.getSeconds() * 1000 -
    now.getMilliseconds() +
    2000; // 2秒バッファ

  const nextTime = new Date(now.getTime() + msUntilNext);
  const nextJST = new Date(nextTime.getTime() + 9 * 60 * 60 * 1000);
  console.log(`⏰ 次のデータ取得: ${String(nextJST.getUTCHours()).padStart(2, '0')}:${String(nextJST.getUTCMinutes()).padStart(2, '0')} (${Math.round(msUntilNext / 1000)}秒後)`);

  setTimeout(async () => {
    try {
      await fetchAllExchanges();
    } catch (err) {
      console.error('❌ 30分データ取得エラー:', err.message);
    }
    // 完了後、次の30分刻みを再計算してスケジュール（ドリフトしない）
    scheduleNextHalfHourlyFetch();
  }, msUntilNext);
}

// ════════════════════════════════════════════════════
// API Routes（メモリ上のデータを返すだけ。取引所APIは叩かない）
// ════════════════════════════════════════════════════

function createHandler(exchangeId) {
  return (req, res) => {
    const data = getExchangeData(exchangeId);
    if (!data) {
      return res.status(503).json({ error: 'データ準備中です。しばらくお待ちください。' });
    }
    res.json(data);
  };
}

app.get('/api/volume/top100', createHandler('binance-futures'));
app.get('/api/bitget/spot/top100', createHandler('bitget-spot'));
app.get('/api/upbit/spot/top100', createHandler('upbit-spot'));
app.get('/api/binance/alpha/top100', createHandler('binance-alpha'));

app.get('/api/health', (req, res) => {
  const exchanges = Object.keys(store).map(id => ({
    id,
    hasData: !!store[id]?.current,
    snapshots: store[id]?.snapshots?.length || 0,
    lastUpdate: store[id]?.current?.timestamp
      ? new Date(store[id].current.timestamp).toISOString()
      : null,
  }));
  res.json({ status: 'ok', uptime: process.uptime(), exchanges, persistence: persist.getStatus(), momentum: momentum.getStatus() });
});

// ════════════════════════════════════════════════════
// 履歴API（永続化したスナップショットを返す）
// ════════════════════════════════════════════════════

const EXCHANGE_IDS = new Set(['binance-futures', 'bitget-spot', 'upbit-spot', 'binance-alpha']);

function parseTs(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n; // 秒でもミリ秒でも受ける
  const d = Date.parse(v);
  return Number.isFinite(d) ? d : fallback;
}

function historyHandler(fn) {
  return async (req, res) => {
    if (!EXCHANGE_IDS.has(req.params.exchange)) {
      return res.status(404).json({ error: `unknown exchange: ${req.params.exchange}` });
    }
    if (!persist.getStatus().ready) {
      return res.status(503).json({ error: '永続化が有効ではありません', persistence: persist.getStatus() });
    }
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(500).json({ error: persist.redact(err.message) });
    }
  };
}

// 銘柄の順位・出来高の時系列  例: /api/history/binance-futures/symbol/BTCUSDT?days=7
app.get('/api/history/:exchange/symbol/:symbol', historyHandler(async (req) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 0.01), 400);
  const toTs = parseTs(req.query.to, Date.now());
  const fromTs = parseTs(req.query.from, toTs - days * 86400000);
  const limit = Math.min(Number(req.query.limit) || 2000, 20000);
  const symbol = req.params.symbol.toUpperCase();
  const points = await persist.getSymbolHistory(req.params.exchange, symbol, { fromTs, toTs, limit });
  return { exchange: req.params.exchange, symbol, from: fromTs, to: toTs, count: points.length, points };
}));

// スナップショット一覧  例: /api/history/binance-futures/snapshots?days=2
app.get('/api/history/:exchange/snapshots', historyHandler(async (req) => {
  const days = Math.min(Math.max(Number(req.query.days) || 2, 0.01), 400);
  const toTs = parseTs(req.query.to, Date.now());
  const fromTs = parseTs(req.query.from, toTs - days * 86400000);
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  const snapshots = await persist.listSnapshots(req.params.exchange, { fromTs, toTs, limit });
  return { exchange: req.params.exchange, from: fromTs, to: toTs, count: snapshots.length, snapshots };
}));

// 指定時刻時点の順位表  例: /api/history/binance-futures/at?ts=2026-10-01T00:00:00Z&top=100
app.get('/api/history/:exchange/at', historyHandler(async (req) => {
  const ts = parseTs(req.query.ts, Date.now());
  const top = Math.min(Number(req.query.top) || 100, 1000);
  const snapshot = await persist.getSnapshotAt(req.params.exchange, ts, { top });
  if (!snapshot) return { exchange: req.params.exchange, ts, snapshot: null };
  return { exchange: req.params.exchange, requestedTs: ts, ...snapshot };
}));

// 保存状況のサマリ
app.get('/api/history/stats', async (req, res) => {
  try {
    res.json({ persistence: persist.getStatus(), exchanges: await persist.getStats() });
  } catch (err) {
    res.status(500).json({ error: persist.redact(err.message) });
  }
});

// ════════════════════════════════════════════════════
// 急上昇（15分の上昇率）
// ════════════════════════════════════════════════════

app.get('/api/momentum', (req, res) => {
  res.json(momentum.getView());
});

// 通知の履歴  例: /api/momentum/alerts?days=7
app.get('/api/momentum/alerts', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 0.01), 400);
  try {
    const alerts = await momentum.getAlertHistory(Date.now() - days * 86400000);
    res.json({ days, count: alerts.length, alerts });
  } catch (err) {
    res.status(500).json({ error: persist.redact(err.message) });
  }
});

// ── 本番環境: フロントエンド配信 ──
if (process.env.NODE_ENV === 'production') {
  const frontendPath = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// ── サーバー起動 ──
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ サーバー起動: http://localhost:${PORT}`);
  await persist.init();
  console.log('📸 起動時データ取得中...');
  await fetchAllExchanges();
  scheduleNextHalfHourlyFetch();
  momentum.start().catch(err => console.error('❌ [急上昇] 起動に失敗:', err.message));
});
