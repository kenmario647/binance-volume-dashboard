const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Binance API用のaxiosインスタンス（WAF対策） ──
const binanceApi = axios.create({
  baseURL: 'https://fapi.binance.com',
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  },
});

// ── リトライ付きfetch関数 ──
async function fetchWithRetry(url, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // 指数バックオフ: 1秒, 2秒, 4秒...
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`⏳ リトライ ${attempt}/${maxRetries} - ${delay}ms待機...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      const response = await binanceApi.get(url);
      return response;
    } catch (error) {
      const status = error.response?.status;
      console.error(`❌ API呼出失敗 (試行${attempt + 1}/${maxRetries}): ${url} - Status: ${status || 'N/A'} - ${error.message}`);
      // 418, 429はリトライ可能、それ以外の4xxはリトライ不要
      if (status && status >= 400 && status < 500 && status !== 418 && status !== 429) {
        throw error;
      }
      if (attempt === maxRetries - 1) throw error;
    }
  }
}

// ── キャッシュ ──
let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 60 * 1000; // 60秒（レート制限対策で延長）

// exchangeInfoキャッシュ（アクティブ銘柄リスト）
let activeSymbols = null;
let activeSymbolsFetchTime = 0;
const EXCHANGE_INFO_CACHE_DURATION = 30 * 60 * 1000; // 30分（延長）

/**
 * Binance exchangeInfo からステータスが TRADING のUSDT先物シンボルを取得
 * デリスト済み・予定の銘柄を除外するために使用
 */
async function fetchActiveSymbols() {
  const now = Date.now();

  if (activeSymbols && now - activeSymbolsFetchTime < EXCHANGE_INFO_CACHE_DURATION) {
    return activeSymbols;
  }

  try {
    const response = await fetchWithRetry('/fapi/v1/exchangeInfo');
    const symbols = response.data.symbols;

    activeSymbols = new Set(
      symbols
        .filter(s => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
        .map(s => s.symbol)
    );
    activeSymbolsFetchTime = now;

    console.log(`✅ アクティブ銘柄数: ${activeSymbols.size} (USDT-M TRADING)`);
    return activeSymbols;
  } catch (error) {
    console.error('exchangeInfo取得エラー:', error.message);
    if (activeSymbols) return activeSymbols;
    return null;
  }
}

/**
 * Binance先物APIから全銘柄の24hティッカーを取得し、
 * TRADING状態の銘柄のみフィルタ →
 * quoteVolume（USDT建て出来高）で降順ソート → 上位100を返す
 */
async function fetchTop100Volume() {
  const now = Date.now();

  // キャッシュが有効ならそのまま返す
  if (cachedData && now - lastFetchTime < CACHE_DURATION) {
    return cachedData;
  }

  try {
    // アクティブ銘柄リストを先に取得
    const tradingSymbols = await fetchActiveSymbols();

    // リクエスト間に少し待機（WAF対策）
    await new Promise(resolve => setTimeout(resolve, 500));

    // ティッカーデータ取得
    const tickerResponse = await fetchWithRetry('/fapi/v1/ticker/24hr');
    const tickers = tickerResponse.data;

    // USDTペア & TRADING状態のみフィルタ → quoteVolumeで降順ソート → 上位100
    const sorted = tickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT')) return false;
        // exchangeInfoが取得できた場合はTRADING状態のみ許可
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

    cachedData = {
      data: sorted,
      timestamp: now,
      total: totalActive,
    };
    lastFetchTime = now;

    console.log(`✅ データ更新完了: ${sorted.length}銘柄 / 合計${totalActive}銘柄`);
    return cachedData;
  } catch (error) {
    console.error('Binance API取得エラー:', error.message);
    // キャッシュがあれば古いデータを返す
    if (cachedData) return cachedData;
    throw error;
  }
}

// ── API Routes ──

app.get('/api/volume/top100', async (req, res) => {
  try {
    const result = await fetchTop100Volume();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'データ取得に失敗しました', details: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── 本番環境: フロントエンドの静的ファイル配信 ──
if (process.env.NODE_ENV === 'production') {
  const frontendPath = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendPath));

  // API以外のリクエストはindex.htmlにフォールバック（SPA対応）
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// ── サーバー起動 ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ サーバー起動: http://localhost:${PORT} (${process.env.NODE_ENV || 'development'})`);
});
