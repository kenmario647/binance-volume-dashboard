const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

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

function saveExchangeData(exchangeId, data) {
  if (!data?.length) return;

  const timeLabel = getJSTTimeLabel();
  const rankings = {};
  data.forEach((item, index) => {
    rankings[item.symbol] = { rank: index + 1, volume: item.quoteVolume };
  });

  if (!store[exchangeId]) store[exchangeId] = { current: null, snapshots: [] };

  // 最新データを保存
  store[exchangeId].current = { data, timestamp: Date.now() };

  // スナップショットを追加
  store[exchangeId].snapshots.push({ time: timeLabel, timestamp: Date.now(), rankings });
  while (store[exchangeId].snapshots.length > MAX_SNAPSHOTS) {
    store[exchangeId].snapshots.shift();
  }

  console.log(`📸 [${exchangeId}] データ保存: ${timeLabel} (スナップショット ${store[exchangeId].snapshots.length}件)`);
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

  s.snapshots.push({ time: timeLabel, timestamp: Date.now(), rankings });
  while (s.snapshots.length > MAX_SNAPSHOTS) {
    s.snapshots.shift();
  }

  console.log(`⚠️ [${exchangeId}] フォールバック: 前回データでスナップショット保存 ${timeLabel} (計${s.snapshots.length}件)`);
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
    const sorted = tickerResponse.data
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
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    saveExchangeData('binance-futures', sorted);
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
    const alphaSymbolSet = new Set(
      alphaTokens.map(t => (t.symbol || '').toUpperCase() + 'USDT')
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    const tickerResponse = await fetchWithRetry(binanceApi, '/fapi/v1/ticker/24hr');
    const sorted = tickerResponse.data
      .filter(t => alphaSymbolSet.has(t.symbol))
      .map(t => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        priceChangePercent: parseFloat(t.priceChangePercent),
        quoteVolume: parseFloat(t.quoteVolume),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    saveExchangeData('binance-alpha', sorted);
    console.log(`✅ [Alpha先物] ${sorted.length}銘柄取得`);
  } catch (error) {
    console.error(`[Alpha先物] エラー: ${error.message} (code=${error.code || 'N/A'}, status=${error.response?.status || 'N/A'})`);
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
  res.json({ status: 'ok', uptime: process.uptime(), exchanges });
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
  console.log('📸 起動時データ取得中...');
  await fetchAllExchanges();
  scheduleNextHalfHourlyFetch();
});
