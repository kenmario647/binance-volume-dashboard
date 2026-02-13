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
