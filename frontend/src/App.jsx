import { useEffect, useState, useCallback } from 'react';
import VolumeTable from './components/VolumeTable';
import { useVolumeData, formatVolume } from './utils';
import './index.css';

const REFRESH_INTERVAL = 30000; // 30秒

function App() {
  const { data, loading, error, lastUpdate, fetchData } = useVolumeData();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setTimeout(() => setRefreshing(false), 600);
  }, [fetchData]);

  // 統計値の計算
  const stats = data?.data ? {
    totalVolume: data.data.reduce((sum, item) => sum + item.quoteVolume, 0),
    avgChange: data.data.reduce((sum, item) => sum + item.priceChangePercent, 0) / data.data.length,
    gainers: data.data.filter(item => item.priceChangePercent > 0).length,
    losers: data.data.filter(item => item.priceChangePercent < 0).length,
    totalCoins: data.total,
  } : null;

  if (error && !data) {
    return (
      <div className="error-container">
        <div className="error-icon">⚠️</div>
        <div className="error-text">データ取得エラー</div>
        <div className="error-detail">{error}</div>
        <button className="refresh-btn" onClick={handleRefresh}>再試行</button>
      </div>
    );
  }

  return (
    <>
      {/* ヘッダー */}
      <header className="header">
        <div className="header-content">
          <div className="header-left">
            <div className="logo">Binance Futures Volume</div>
            <span className="badge">TOP 100</span>
          </div>
          <div className="header-right">
            {lastUpdate && (
              <span className="last-update">
                更新: {lastUpdate.toLocaleTimeString('ja-JP')}
              </span>
            )}
            <button
              className={`refresh-btn ${refreshing ? 'loading' : ''}`}
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <span className={`refresh-icon ${refreshing ? 'spinning' : ''}`}>⟳</span>
              更新
            </button>
          </div>
        </div>
      </header>

      {/* 統計サマリー */}
      {stats && (
        <div className="stats-bar">
          <div className="stat-card">
            <div className="stat-label">合計出来高 (Top 100)</div>
            <div className="stat-value cyan">{formatVolume(stats.totalVolume)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">平均変動率</div>
            <div className={`stat-value ${stats.avgChange >= 0 ? 'green' : 'red'}`}>
              {stats.avgChange >= 0 ? '+' : ''}{stats.avgChange.toFixed(2)}%
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">上昇 / 下落</div>
            <div className="stat-value">
              <span className="green">{stats.gainers}</span>
              <span style={{ color: 'var(--text-muted)', margin: '0 6px' }}>/</span>
              <span className="red">{stats.losers}</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">全USDT-M銘柄数</div>
            <div className="stat-value blue">{stats.totalCoins}</div>
          </div>
        </div>
      )}

      {/* テーブル */}
      {loading && !data ? (
        <div className="loading-container">
          <div className="loading-spinner" />
          <div className="loading-text">Binance先物データを取得中...</div>
        </div>
      ) : (
        data && <VolumeTable data={data.data} />
      )}
    </>
  );
}

export default App;
