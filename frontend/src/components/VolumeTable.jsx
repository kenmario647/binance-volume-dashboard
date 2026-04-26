import { useState, useMemo } from 'react';
import { formatVolume, formatPrice, formatPercent, parseSymbol } from '../utils';

const PUMP_THRESHOLD = 10;

function VolumeTable({ data, snapshots = [] }) {
    const [sortConfig, setSortConfig] = useState({ key: null, direction: 'ascending' });

    // PUMP判定: 1h前スナップ → 現在(最新スナップ)の順位上昇のみで評価
    // 前回スナップに無い = 圏外(>100位)からのエントリ扱い
    const getPumpInfo = (symbol) => {
        if (snapshots.length < 2) return { score: 0, isNew: false, prevRank: null, curRank: null };
        const current = snapshots[snapshots.length - 1];
        const previous = snapshots[snapshots.length - 2];
        const curRank = current?.rankings[symbol]?.rank;
        const prevRank = previous?.rankings[symbol]?.rank;
        if (curRank == null) return { score: 0, isNew: false, prevRank, curRank };
        if (prevRank == null) {
            return { score: 101 - curRank, isNew: true, prevRank: null, curRank };
        }
        return { score: prevRank - curRank, isNew: false, prevRank, curRank };
    };

    const sortedData = useMemo(() => {
        if (!data) return [];
        let items = [...data];
        if (sortConfig.key !== null) {
            items.sort((a, b) => {
                let valA = a[sortConfig.key];
                let valB = b[sortConfig.key];
                if (sortConfig.key === 'symbol') {
                    valA = String(valA).toLowerCase();
                    valB = String(valB).toLowerCase();
                } else {
                    valA = parseFloat(valA) || 0;
                    valB = parseFloat(valB) || 0;
                }
                if (valA < valB) return sortConfig.direction === 'ascending' ? -1 : 1;
                if (valA > valB) return sortConfig.direction === 'ascending' ? 1 : -1;
                return 0;
            });
        }
        return items;
    }, [data, sortConfig]);

    const requestSort = (key) => {
        let direction = 'ascending';
        if (sortConfig.key === key && sortConfig.direction === 'ascending') {
            direction = 'descending';
        }
        setSortConfig({ key, direction });
    };

    const getSortClass = (key) => {
        if (sortConfig.key !== key) return '';
        return sortConfig.direction;
    };

    // 固定列
    const fixedColumns = [
        { key: 'rank', label: '#', sortable: false },
        { key: 'symbol', label: '銘柄' },
        { key: 'quoteVolume', label: '24h出来高' },
    ];

    // スナップショット列（最大6つ、最新を左に配置 = スマホでも一番見たい列が即見える）
    const snapshotColumns = [...snapshots].reverse().map((snap, idx, arr) => ({
        key: `snap_${idx}`,
        label: idx === 0
            ? `${snap.time} (現在)`
            : (idx === arr.length - 1 ? `${snap.time} (起動)` : snap.time),
        snapshot: snap,
    }));

    return (
        <div className="table-wrapper">
            <table className="volume-table">
                <thead>
                    <tr>
                        {fixedColumns.map(col => (
                            <th
                                key={col.key}
                                className={`${col.sortable !== false ? 'sortable' : ''} ${getSortClass(col.key)}`}
                                onClick={() => col.sortable !== false && requestSort(col.key)}
                            >
                                <span className="th-content">
                                    {col.label}
                                    {sortConfig.key === col.key && (
                                        <span className="sort-arrow">
                                            {sortConfig.direction === 'ascending' ? '▲' : '▼'}
                                        </span>
                                    )}
                                </span>
                            </th>
                        ))}
                        {snapshotColumns.map(col => (
                            <th key={col.key} className="snapshot-header">
                                <span className="th-content">{col.label}</span>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {sortedData.map((item, index) => {
                        const { base, quote } = parseSymbol(item.symbol);
                        const displayName = item.displayName || base;
                        const rank = index + 1;
                        const changePercent = item.priceChangePercent;
                        const changeClass = changePercent >= 0 ? 'positive' : 'negative';

                        const pump = getPumpInfo(item.symbol);
                        const isPump = pump.score >= PUMP_THRESHOLD;
                        const pumpTitle = pump.isNew
                            ? `1h前は圏外 (>100位) → 現在 #${pump.curRank}`
                            : `1h前 #${pump.prevRank} → 現在 #${pump.curRank} (+${pump.score})`;

                        return (
                            <tr key={item.symbol} className={isPump ? 'pump-row' : ''}>
                                <td>
                                    <span className={`rank-badge ${rank <= 3 ? `rank-${rank}` : ''}`}>
                                        {rank}
                                    </span>
                                </td>
                                <td>
                                    <div className="symbol-cell">
                                        {isPump && (
                                            <span className="pump-icon" title={pumpTitle}>
                                                {pump.isNew ? '🆕' : '🔥'}
                                            </span>
                                        )}
                                        <span className="symbol-base">{displayName}</span>
                                        <span className="symbol-quote">/ {quote || 'USDT'}</span>
                                    </div>
                                </td>
                                <td className="volume-cell">{formatVolume(item.quoteVolume)}</td>

                                {/* スナップショット列 */}
                                {snapshotColumns.map((col, colIdx) => {
                                    const snapData = col.snapshot.rankings[item.symbol];
                                    if (!snapData) {
                                        return <td key={col.key} className="snapshot-td"><span className="snap-muted">-</span></td>;
                                    }
                                    // 1h前(=右隣の列)との順位差。最右(=最古)はリファレンス無しなので0。
                                    let rankDiff = 0;
                                    if (colIdx < snapshotColumns.length - 1) {
                                        const earlierSnap = snapshotColumns[colIdx + 1].snapshot.rankings[item.symbol];
                                        if (earlierSnap) {
                                            rankDiff = earlierSnap.rank - snapData.rank; // 正=上昇、負=下降
                                        }
                                    }
                                    return (
                                        <td key={col.key} className="snapshot-td">
                                            <div className="snap-content">
                                                {rankDiff !== 0 && (
                                                    <span className={`snap-diff ${rankDiff > 0 ? 'up' : 'down'}`}>
                                                        {rankDiff > 0 ? `↑${rankDiff}` : `↓${Math.abs(rankDiff)}`}
                                                    </span>
                                                )}
                                                <div className="snap-stack">
                                                    <span className="snap-rank">#{snapData.rank}</span>
                                                    <span className="snap-volume">{formatVolume(snapData.volume)}</span>
                                                </div>
                                            </div>
                                        </td>
                                    );
                                })}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

export default VolumeTable;
