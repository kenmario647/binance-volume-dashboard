import { useEffect, useState, useCallback, useRef } from 'react';
import VolumeTable from './components/VolumeTable';
import { useExchangeData, TABS, formatVolume } from './utils';
import './index.css';

const REFRESH_INTERVAL = 60000; // 60秒

function App() {
  const [activeTab, setActiveTab] = useState(TABS[0].id);
  const { dataMap, loadingMap, errorMap, lastUpdateMap, fetchData } = useExchangeData();
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef(null);

  const currentTab = TABS.find(t => t.id === activeTab);
  const data = dataMap[activeTab];
  const loading = loadingMap[activeTab];
  const error = errorMap[activeTab];
  const lastUpdate = lastUpdateMap[activeTab];

  // タブ切り替え時・初回ロード
  useEffect(() => {
    if (!dataMap[activeTab]) {
      fetchData(activeTab);
    }
    // 自動更新
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => fetchData(activeTab), REFRESH_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [activeTab, fetchData]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData(activeTab);
    setTimeout(() => setRefreshing(false), 600);
  }, [fetchData, activeTab]);

  const handleTabChange = useCallback((tabId) => {
    setActiveTab(tabId);
  }, []);

  // 統計値
  const stats = data?.data ? {
    totalVolume: data.data.reduce((sum, item) => sum + item.quoteVolume, 0),
    avgChange: data.data.reduce((sum, item) => sum + item.priceChangePercent, 0) / data.data.length,
    gainers: data.data.filter(item => item.priceChangePercent > 0).length,
    losers: data.data.filter(item => item.priceChangePercent < 0).length,
    totalCoins: data.total,
  } : null;

  const currency = currentTab?.currency || 'USD';

  return (
    <>
      {/* ヘッダー */}
      <header className="header">
        <div className="header-content">
          <div className="header-left">
            <div className="logo">
              <span className="logo-icon">{currentTab?.icon}</span>
              {currentTab?.label || 'Volume'}
            </div>
            <span className="badge" style={{ background: currentTab?.color }}>
              {currentTab?.badgeText}
            </span>
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

      {/* タブ */}
      <nav className="tabs-nav">
        <div className="tabs-container">
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => handleTabChange(tab.id)}
              style={activeTab === tab.id ? { borderColor: tab.color, color: tab.color } : {}}
            >
              <span className="tab-icon">{tab.icon}</span>
              <span className="tab-label-full">{tab.label}</span>
              <span className="tab-label-short">{tab.shortLabel}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* 統計サマリー */}
      {stats && (
        <div className="stats-bar">
          <div className="stat-card">
            <div className="stat-label">合計出来高 (Top {data.data.length})</div>
            <div className="stat-value cyan">{formatVolume(stats.totalVolume, currency)}</div>
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
            <div className="stat-label">全銘柄数</div>
            <div className="stat-value blue">{stats.totalCoins}</div>
          </div>
        </div>
      )}

      {/* エラー状態 */}
      {error && !data && (
        <div className="error-container">
          <div className="error-icon">⚠️</div>
          <div className="error-text">データ取得エラー</div>
          <div className="error-detail">{error}</div>
          <button className="refresh-btn" onClick={handleRefresh}>再試行</button>
        </div>
      )}

      {/* テーブル */}
      {loading && !data ? (
        <div className="loading-container">
          <div className="loading-spinner" />
          <div className="loading-text">{currentTab?.description}データを取得中...</div>
        </div>
      ) : (
        data && <VolumeTable data={data.data} currency={currency} />
      )}
    </>
  );
}

export default App;
