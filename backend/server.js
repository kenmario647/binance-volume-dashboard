const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── キャッシュ ──
let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 30 * 1000; // 30秒

// exchangeInfoキャッシュ（アクティブ銘柄リスト）
let activeSymbols = null;
let activeSymbolsFetchTime = 0;
const EXCHANGE_INFO_CACHE_DURATION = 10 * 60 * 1000; // 10分

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
    const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
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
    // アクティブ銘柄リストとティッカーデータを並行取得
    const [tradingSymbols, tickerResponse] = await Promise.all([
      fetchActiveSymbols(),
      axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr'),
    ]);

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
    res.status(500).json({ error: 'データ取得に失敗しました' });
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
