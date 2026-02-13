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

// 汎用リトライ関数
async function fetchWithRetry(axiosInstance, url, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`⏳ リトライ ${attempt}/${maxRetries} - ${delay}ms待機...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      const response = await axiosInstance.get(url);
      return response;
    } catch (error) {
      const status = error.response?.status;
      console.error(`❌ API失敗 (${attempt + 1}/${maxRetries}): ${url} - ${status || 'N/A'} - ${error.message}`);
      if (status && status >= 400 && status < 500 && status !== 418 && status !== 429) {
        throw error;
      }
      if (attempt === maxRetries - 1) throw error;
    }
  }
}

// 汎用キャッシュ
class DataCache {
  constructor(duration = 60000) {
    this.data = null;
    this.lastFetchTime = 0;
    this.duration = duration;
  }
  isValid() {
    return this.data && Date.now() - this.lastFetchTime < this.duration;
  }
  set(data) {
    this.data = data;
    this.lastFetchTime = Date.now();
  }
  get() {
    return this.data;
  }
}

// ════════════════════════════════════════════════════
// 1. Binance 先物 (既存)
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
    console.log(`✅ [Binance先物] アクティブ銘柄: ${activeSymbolsSet.size}`);
    return activeSymbolsSet;
  } catch (error) {
    console.error('[Binance先物] exchangeInfoエラー:', error.message);
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
        volume: parseFloat(t.volume),
        quoteVolume: parseFloat(t.quoteVolume),
        highPrice: parseFloat(t.highPrice),
        lowPrice: parseFloat(t.lowPrice),
        weightedAvgPrice: parseFloat(t.weightedAvgPrice),
        count: parseInt(t.count, 10),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    const totalActive = tickers.filter(t => {
      if (!t.symbol.endsWith('USDT')) return false;
      if (tradingSymbols) return tradingSymbols.has(t.symbol);
      return true;
    }).length;

    const result = { data: sorted, timestamp: Date.now(), total: totalActive };
    binanceFuturesCache.set(result);
    console.log(`✅ [Binance先物] ${sorted.length}銘柄 / 合計${totalActive}`);
    return result;
  } catch (error) {
    console.error('[Binance先物] エラー:', error.message);
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
        volume: parseFloat(t.baseVolume || 0),
        quoteVolume: parseFloat(t.usdtVolume || t.quoteVolume || 0),
        highPrice: parseFloat(t.high24h || 0),
        lowPrice: parseFloat(t.low24h || 0),
        weightedAvgPrice: 0,
        count: 0,
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    const totalActive = tickers.filter(t => t.symbol.endsWith('USDT')).length;

    const result = { data: sorted, timestamp: Date.now(), total: totalActive };
    bitgetCache.set(result);
    console.log(`✅ [Bitget現物] ${sorted.length}銘柄 / 合計${totalActive}`);
    return result;
  } catch (error) {
    console.error('[Bitget現物] エラー:', error.message);
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
      .map(m => ({
        market: m.market,
        koreanName: m.korean_name,
        englishName: m.english_name,
      }));
    upbitMarketsCache.set(true);
    console.log(`✅ [Upbit] マーケット数: ${upbitMarketsList.length}`);
    return upbitMarketsList;
  } catch (error) {
    console.error('[Upbit] マーケット取得エラー:', error.message);
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

    // USDT/KRWレートからKRW→USD換算レートを取得
    let krwToUsd = 1 / 1450; // デフォルト（フォールバック）
    const usdtTicker = tickers.find(t => t.market === 'KRW-USDT');
    if (usdtTicker && usdtTicker.trade_price) {
      krwToUsd = 1 / parseFloat(usdtTicker.trade_price);
      console.log(`✅ [Upbit] KRW/USD レート: 1 USD = ₩${usdtTicker.trade_price}`);
    }

    // マーケット名のマップを作成
    const nameMap = {};
    markets.forEach(m => { nameMap[m.market] = m; });

    const sorted = tickers
      .filter(t => t.market !== 'KRW-USDT') // USDTは除外
      .map(t => {
        const base = t.market.replace('KRW-', '');
        const priceKrw = parseFloat(t.trade_price || 0);
        const volumeKrw = parseFloat(t.acc_trade_price_24h || 0);
        const highKrw = parseFloat(t.high_price || 0);
        const lowKrw = parseFloat(t.low_price || 0);
        return {
          symbol: `${base}USDT`,
          displayName: base,
          lastPrice: priceKrw * krwToUsd,
          priceChangePercent: parseFloat(t.signed_change_rate || 0) * 100,
          volume: parseFloat(t.acc_trade_volume_24h || 0),
          quoteVolume: volumeKrw * krwToUsd,
          highPrice: highKrw * krwToUsd,
          lowPrice: lowKrw * krwToUsd,
          weightedAvgPrice: 0,
          count: 0,
          currency: 'USD',
        };
      })
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    const result = { data: sorted, timestamp: Date.now(), total: tickers.length - 1 };
    upbitCache.set(result);
    console.log(`✅ [Upbit現物] ${sorted.length}銘柄 / 合計${tickers.length - 1} (USD換算済)`);
    return result;
  } catch (error) {
    console.error('[Upbit現物] エラー:', error.message);
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
    console.log(`✅ [Alpha] トークン数: ${alphaTokenList.length}`);
    return alphaTokenList;
  } catch (error) {
    console.error('[Alpha] トークンリスト取得エラー:', error.message);
    return alphaTokenList || [];
  }
}

async function fetchBinanceAlphaTop100() {
  if (alphaCache.isValid()) return alphaCache.get();

  try {
    // Alphaトークンリスト取得
    const alphaTokens = await fetchAlphaTokenList();
    if (!alphaTokens.length) throw new Error('Alphaトークンリストが取得できません');

    // Alphaシンボル名のセットを作成（大文字に正規化）
    const alphaSymbolSet = new Set(
      alphaTokens.map(t => (t.symbol || '').toUpperCase() + 'USDT')
    );

    await new Promise(resolve => setTimeout(resolve, 500));

    // Binance先物の24hティッカーからAlpha銘柄をフィルタ
    const tickerResponse = await fetchWithRetry(binanceApi, '/fapi/v1/ticker/24hr');
    const tickers = tickerResponse.data;

    const alphaTickers = tickers
      .filter(t => alphaSymbolSet.has(t.symbol))
      .map(t => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        priceChangePercent: parseFloat(t.priceChangePercent),
        volume: parseFloat(t.volume),
        quoteVolume: parseFloat(t.quoteVolume),
        highPrice: parseFloat(t.highPrice),
        lowPrice: parseFloat(t.lowPrice),
        weightedAvgPrice: parseFloat(t.weightedAvgPrice),
        count: parseInt(t.count, 10),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    const result = { data: alphaTickers, timestamp: Date.now(), total: alphaSymbolSet.size };
    alphaCache.set(result);
    console.log(`✅ [Alpha先物] ${alphaTickers.length}銘柄 / Alphaリスト${alphaSymbolSet.size}`);
    return result;
  } catch (error) {
    console.error('[Alpha先物] エラー:', error.message);
    if (alphaCache.get()) return alphaCache.get();
    throw error;
  }
}

// ════════════════════════════════════════════════════
// API Routes
// ════════════════════════════════════════════════════

// Binance先物（既存）
app.get('/api/volume/top100', async (req, res) => {
  try {
    const result = await fetchBinanceFuturesTop100();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'データ取得に失敗しました', details: error.message });
  }
});

// Bitget現物
app.get('/api/bitget/spot/top100', async (req, res) => {
  try {
    const result = await fetchBitgetSpotTop100();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Bitgetデータ取得に失敗しました', details: error.message });
  }
});

// Upbit現物
app.get('/api/upbit/spot/top100', async (req, res) => {
  try {
    const result = await fetchUpbitSpotTop100();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Upbitデータ取得に失敗しました', details: error.message });
  }
});

// Binance Alpha先物
app.get('/api/binance/alpha/top100', async (req, res) => {
  try {
    const result = await fetchBinanceAlphaTop100();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Alpha先物データ取得に失敗しました', details: error.message });
  }
});

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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ サーバー起動: http://localhost:${PORT} (${process.env.NODE_ENV || 'development'})`);
});
