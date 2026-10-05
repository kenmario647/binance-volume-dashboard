import { useCallback, useEffect, useState } from 'react';
import { API_BASE, formatVolume, formatPrice } from '../utils';

const REFRESH_MS = 60000;
const toJst = ts => new Date(ts + 9 * 3600000).toISOString();
const hhmm = ts => toJst(ts).slice(11, 16);
const mdhm = ts => `${toJst(ts).slice(5, 10).replace('-', '/')} ${hhmm(ts)}`;
const pctText = v => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const pctClass = v => (v == null ? '' : v >= 0 ? 'positive' : 'negative');

function SymbolLink({ symbol, pump }) {
    return (
        <a className="symbol-cell momentum-link" href={`https://www.binance.com/ja/futures/${symbol}`} target="_blank" rel="noopener noreferrer">
            {pump && <span className="pump-icon">🚀</span>}
            <span className="symbol-base">{symbol.replace(/USDT$/, '')}</span>
            <span className="symbol-quote">/ USDT</span>
        </a>
    );
}

function MomentumView() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/momentum`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setData(await res.json());
            setError(null);
        } catch (err) {
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, REFRESH_MS);
        return () => clearInterval(id);
    }, [load]);

    if (!data) {
        return error ? (
            <div className="error-container">
                <div className="error-icon">⚠️</div>
                <div className="error-text">データ取得エラー</div>
                <div className="error-detail">{error}</div>
                <button className="refresh-btn" onClick={load}>再試行</button>
            </div>
        ) : (
            <div className="loading-container">
                <div className="loading-spinner" />
                <div className="loading-text">急上昇データを取得中...</div>
            </div>
        );
    }

    if (!data.enabled) {
        return <div className="momentum-empty">急上昇の監視は停止中です（MOMENTUM_DISABLED=1）。</div>;
    }
    if (!data.ready) {
        return (
            <div className="loading-container">
                <div className="loading-spinner" />
                <div className="loading-text">準備中です（起動直後は1分ほどかかります）</div>
            </div>
        );
    }

    const { config, notify, items, alerts } = data;
    const threshold = config.thresholdPct;
    const pause = config.pauseMin % 60 === 0 ? `${config.pauseMin / 60}時間` : `${config.pauseMin}分`;
    const channels = [notify.bark && 'Bark', notify.ntfy && 'ntfy'].filter(Boolean);

    return (
        <>
            <div className="momentum-info">
                <span><strong>{config.windowMin}分の上昇率</strong>（{config.stepMin}分ごとに更新・最終 {data.updatedAt ? hhmm(data.updatedAt) : '-'}）</span>
                <span>対象 {data.eligible}銘柄（24h出来高 {formatVolume(config.minQuoteVolume)} 以上）</span>
                <span>
                    通知: <strong>+{threshold}%以上</strong>・同じ銘柄は{pause}止める・通知先 {channels.length ? channels.join(' / ') : '未設定'}
                </span>
                {error && <span className="momentum-warn">更新エラー: {error}</span>}
            </div>

            <div className="table-wrapper">
                <table className="volume-table momentum-table">
                    <thead>
                        <tr>
                            <th><span className="th-content">#</span></th>
                            <th><span className="th-content">銘柄</span></th>
                            <th><span className="th-content">{config.windowMin}分</span></th>
                            <th><span className="th-content">60分</span></th>
                            <th><span className="th-content">24h</span></th>
                            <th><span className="th-content">24h出来高</span></th>
                            <th className="hide-sm"><span className="th-content">価格</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.map(it => {
                            const pump = it.pct15 >= threshold;
                            return (
                                <tr key={it.symbol} className={pump ? 'pump-row' : ''}>
                                    <td><span className={`rank-badge ${it.rank <= 3 ? `rank-${it.rank}` : ''}`}>{it.rank}</span></td>
                                    <td><SymbolLink symbol={it.symbol} pump={pump} /></td>
                                    <td className={pctClass(it.pct15)}>{pctText(it.pct15)}</td>
                                    <td className={pctClass(it.pct60)}>{pctText(it.pct60)}</td>
                                    <td className={pctClass(it.change24h)}>{pctText(it.change24h)}</td>
                                    <td className="volume-cell">{formatVolume(it.quoteVolume)}</td>
                                    <td className="price-cell hide-sm">{formatPrice(it.price)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div className="momentum-section-title">直近24時間の通知（{alerts.length}件）</div>
            {alerts.length === 0 ? (
                <div className="momentum-empty">まだ通知はありません。{config.windowMin}分で+{threshold}%以上上がった銘柄が出ると、ここに記録されます。</div>
            ) : (
                <div className="table-wrapper">
                    <table className="volume-table momentum-table">
                        <thead>
                            <tr>
                                <th><span className="th-content">時刻</span></th>
                                <th><span className="th-content">銘柄</span></th>
                                <th><span className="th-content">通知時の{config.windowMin}分</span></th>
                                <th><span className="th-content">その後の最高</span></th>
                                <th><span className="th-content">24h出来高</span></th>
                                <th className="hide-sm"><span className="th-content">通知時の価格</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {alerts.map(a => (
                                <tr key={`${a.symbol}-${a.ts}`}>
                                    <td className="momentum-time">{mdhm(a.ts)}</td>
                                    <td><SymbolLink symbol={a.symbol} pump={false} /></td>
                                    <td className="positive">{pctText(a.pct15)}</td>
                                    <td className={pctClass(a.maxGainPct)} title="通知から4時間以内の最高値">{pctText(a.maxGainPct)}</td>
                                    <td className="volume-cell">{a.quoteVolume != null ? formatVolume(a.quoteVolume) : '-'}</td>
                                    <td className="price-cell hide-sm">{formatPrice(a.price)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}

export default MomentumView;
