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

async function fetchWithRetry(axiosInstance, url, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      const response = await axiosInstance.get(url);
      return response;
    } catch (error) {
      const status = error.response?.status;
      console.error(`❌ API失敗 (${attempt + 1}/${maxRetries}): ${url} - ${status || 'N/A'}`);
      if (status && status >= 400 && status < 500 && status !== 418 && status !== 429) throw error;
      if (attempt === maxRetries - 1) throw error;
    }
  }
}

class DataCache {
  constructor(duration = 60000) {
    this.data = null;
    this.lastFetchTime = 0;
    this.duration = duration;
  }
  isValid() { return this.data && Date.now() - this.lastFetchTime < this.duration; }
  set(data) { this.data = data; this.lastFetchTime = Date.now(); }
  get() { return this.data; }
}

// ════════════════════════════════════════════════════
// スナップショットストア（正時の出来高順位を記録）
// ════════════════════════════════════════════════════

const MAX_SNAPSHOTS = 6;

// 各取引所のスナップショット格納
// { 'binance-futures': [ { time: '19:00', timestamp: ..., rankings: { 'BTCUSDT': { rank: 1, volume: 123 }, ... } }, ... ] }
const snapshotStore = {};

function getJSTHour() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.getUTCHours();
}

function getJSTTimeLabel() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

function takeSnapshot(exchangeId, data) {
  if (!data?.data?.length) return;

  const timeLabel = getJSTTimeLabel();
  const rankings = {};
  data.data.forEach((item, index) => {
    rankings[item.symbol] = { rank: index + 1, volume: item.quoteVolume };
  });

  if (!snapshotStore[exchangeId]) snapshotStore[exchangeId] = [];
  const store = snapshotStore[exchangeId];

  // 初回 or 正時: スナップショットを追加
  store.push({ time: timeLabel, timestamp: Date.now(), rankings });

  // 最大件数を超えたら古いものを削除
  while (store.length > MAX_SNAPSHOTS) store.shift();

  console.log(`📸 [${exchangeId}] スナップショット保存: ${timeLabel} (計${store.length}件)`);
}

function getSnapshots(exchangeId) {
  return snapshotStore[exchangeId] || [];
}

// ════════════════════════════════════════════════════
// 1. Binance 先物
// ════════════════════════════════════════════════════

const binanceApi = axios.create({
  baseURL: 'https://fapi.binance.com',
  timeout: 15000,
  headers: DEFAULT_HEADERS,
});

const binanceFuturesCache = new DataCache(60000);
const binanceExchangeInfoCache = new DataCache(30 * 60 * 1000);
let activeSymbolsSet = null;

async function fetchBinanceActiveSymbols() {
  if (binanceExchangeInfoCache.isValid()) return activeSymbolsSet;
  try {
    const response = await fetchWithRetry(binanceApi, '/fapi/v1/exchangeInfo');
    activeSymbolsSet = new Set(
      response.data.symbols
        .filter(s => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
        .map(s => s.symbol)
    );
    binanceExchangeInfoCache.set(true);
    return activeSymbolsSet;
  } catch (error) {
    return activeSymbolsSet;
  }
}

async function fetchBinanceFuturesTop100() {
  if (binanceFuturesCache.isValid()) return binanceFuturesCache.get();
  try {
    const tradingSymbols = await fetchBinanceActiveSymbols();
    await new Promise(resolve => setTimeout(resolve, 500));
    const tickerResponse = await fetchWithRetry(binanceApi, '/fapi/v1/ticker/24hr');
    const tickers = tickerResponse.data;
    const sorted = tickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT')) return false;
        if (tradingSymbols) return tradingSymbols.has(t.symbol);
        return true;
      })
      .map(t => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        priceChangePercent: parseFloat(t.priceChangePercent),
        quoteVolume: parseFloat(t.quoteVolume),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);
    const result = { data: sorted, timestamp: Date.now() };
    binanceFuturesCache.set(result);
    return result;
  } catch (error) {
    if (binanceFuturesCache.get()) return binanceFuturesCache.get();
    throw error;
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

const bitgetCache = new DataCache(60000);

async function fetchBitgetSpotTop100() {
  if (bitgetCache.isValid()) return bitgetCache.get();
  try {
    const response = await fetchWithRetry(bitgetApi, '/api/v2/spot/market/tickers');
    const tickers = response.data.data;
    const sorted = tickers
      .filter(t => t.symbol.endsWith('USDT'))
      .map(t => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPr || 0),
        priceChangePercent: parseFloat(t.change24h || 0) * 100,
        quoteVolume: parseFloat(t.usdtVolume || t.quoteVolume || 0),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);
    const result = { data: sorted, timestamp: Date.now() };
    bitgetCache.set(result);
    return result;
  } catch (error) {
    if (bitgetCache.get()) return bitgetCache.get();
    throw error;
  }
}

// ════════════════════════════════════════════════════
// 3. Upbit 現物
// ════════════════════════════════════════════════════

const upbitApi = axios.create({
  baseURL: 'https://api.upbit.com',
  timeout: 15000,
  headers: DEFAULT_HEADERS,
});

const upbitCache = new DataCache(60000);
const upbitMarketsCache = new DataCache(30 * 60 * 1000);
let upbitMarketsList = null;

async function fetchUpbitMarkets() {
  if (upbitMarketsCache.isValid() && upbitMarketsList) return upbitMarketsList;
  try {
    const response = await fetchWithRetry(upbitApi, '/v1/market/all?is_details=false');
    upbitMarketsList = response.data
      .filter(m => m.market.startsWith('KRW-'))
      .map(m => ({ market: m.market }));
    upbitMarketsCache.set(true);
    return upbitMarketsList;
  } catch (error) {
    return upbitMarketsList || [];
  }
}

async function fetchUpbitSpotTop100() {
  if (upbitCache.isValid()) return upbitCache.get();
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

    const result = { data: sorted, timestamp: Date.now() };
    upbitCache.set(result);
    return result;
  } catch (error) {
    if (upbitCache.get()) return upbitCache.get();
    throw error;
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

const alphaCache = new DataCache(60000);
const alphaListCache = new DataCache(30 * 60 * 1000);
let alphaTokenList = null;

async function fetchAlphaTokenList() {
  if (alphaListCache.isValid() && alphaTokenList) return alphaTokenList;
  try {
    const response = await fetchWithRetry(
      binanceAlphaApiBase,
      '/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list'
    );
    alphaTokenList = response.data.data || [];
    alphaListCache.set(true);
    return alphaTokenList;
  } catch (error) {
    return alphaTokenList || [];
  }
}

async function fetchBinanceAlphaTop100() {
  if (alphaCache.isValid()) return alphaCache.get();
  try {
    const alphaTokens = await fetchAlphaTokenList();
    if (!alphaTokens.length) throw new Error('Alphaトークンリストが取得できません');
    const alphaSymbolSet = new Set(
      alphaTokens.map(t => (t.symbol || '').toUpperCase() + 'USDT')
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    const tickerResponse = await fetchWithRetry(binanceApi, '/fapi/v1/ticker/24hr');
    const tickers = tickerResponse.data;
    const alphaTickers = tickers
      .filter(t => alphaSymbolSet.has(t.symbol))
      .map(t => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        priceChangePercent: parseFloat(t.priceChangePercent),
        quoteVolume: parseFloat(t.quoteVolume),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);
    const result = { data: alphaTickers, timestamp: Date.now() };
    alphaCache.set(result);
    return result;
  } catch (error) {
    if (alphaCache.get()) return alphaCache.get();
    throw error;
  }
}

// ════════════════════════════════════════════════════
// 各取引所のfetch関数マップ
// ════════════════════════════════════════════════════

const EXCHANGE_FETCHERS = {
  'binance-futures': fetchBinanceFuturesTop100,
  'bitget-spot': fetchBitgetSpotTop100,
  'upbit-spot': fetchUpbitSpotTop100,
  'binance-alpha': fetchBinanceAlphaTop100,
};

// ════════════════════════════════════════════════════
// 正時スナップショットスケジューラ
// ════════════════════════════════════════════════════

async function takeAllSnapshots() {
  for (const [id, fetcher] of Object.entries(EXCHANGE_FETCHERS)) {
    try {
      const data = await fetcher();
      takeSnapshot(id, data);
    } catch (err) {
      console.error(`❌ [${id}] スナップショット取得失敗:`, err.message);
    }
  }
}

function scheduleHourlySnapshots() {
  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000 - now.getMilliseconds();

  console.log(`⏰ 次の正時スナップショットまで ${Math.round(msUntilNextHour / 1000)}秒`);

  setTimeout(() => {
    takeAllSnapshots();
    // 以降は毎時0分に実行
    setInterval(takeAllSnapshots, 60 * 60 * 1000);
  }, msUntilNextHour);
}

// ════════════════════════════════════════════════════
// API Routes
// ════════════════════════════════════════════════════

// 汎用ハンドラ: データ + スナップショットを返す
function createExchangeHandler(exchangeId, fetcher) {
  return async (req, res) => {
    try {
      const result = await fetcher();
      res.json({
        ...result,
        snapshots: getSnapshots(exchangeId),
      });
    } catch (error) {
      res.status(500).json({ error: 'データ取得に失敗しました', details: error.message });
    }
  };
}

app.get('/api/volume/top100', createExchangeHandler('binance-futures', fetchBinanceFuturesTop100));
app.get('/api/bitget/spot/top100', createExchangeHandler('bitget-spot', fetchBitgetSpotTop100));
app.get('/api/upbit/spot/top100', createExchangeHandler('upbit-spot', fetchUpbitSpotTop100));
app.get('/api/binance/alpha/top100', createExchangeHandler('binance-alpha', fetchBinanceAlphaTop100));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── 本番環境: フロントエンドの静的ファイル配信 ──
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

  // 起動時スナップショット（初回）
  console.log('📸 起動時スナップショットを取得中...');
  await takeAllSnapshots();

  // 正時スケジューラ開始
  scheduleHourlySnapshots();
});
