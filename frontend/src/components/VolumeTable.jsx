import { useState, useMemo } from 'react';
import { formatVolume, formatPrice, formatPercent, parseSymbol } from '../utils';

function VolumeTable({ data, snapshots = [] }) {
    const [sortConfig, setSortConfig] = useState({ key: null, direction: 'ascending' });

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
        { key: 'lastPrice', label: '価格' },
        { key: 'priceChangePercent', label: '24h変動率' },
        { key: 'quoteVolume', label: '24h出来高' },
    ];

    // スナップショット列（最大6つ、時系列の古い順）
    const snapshotColumns = snapshots.map((snap, idx) => ({
        key: `snap_${idx}`,
        label: idx === 0 && snapshots.length > 0 ? `${snap.time} (起動)` : snap.time,
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

                        return (
                            <tr key={item.symbol}>
                                <td>
                                    <span className={`rank-badge ${rank <= 3 ? `rank-${rank}` : ''}`}>
                                        {rank}
                                    </span>
                                </td>
                                <td>
                                    <div className="symbol-cell">
                                        <span className="symbol-base">{displayName}</span>
                                        <span className="symbol-quote">/ {quote || 'USDT'}</span>
                                    </div>
                                </td>
                                <td className="price-cell">{formatPrice(item.lastPrice)}</td>
                                <td className={changeClass}>{formatPercent(changePercent)}</td>
                                <td className="volume-cell">{formatVolume(item.quoteVolume)}</td>

                                {/* スナップショット列 */}
                                {snapshotColumns.map(col => {
                                    const snapData = col.snapshot.rankings[item.symbol];
                                    if (!snapData) {
                                        return <td key={col.key} className="snapshot-cell muted">-</td>;
                                    }
                                    const rankDiff = snapData.rank - rank; // 正=順位が落ちた、負=順位が上がった
                                    return (
                                        <td key={col.key} className="snapshot-cell">
                                            <span className="snap-rank">#{snapData.rank}</span>
                                            <span className="snap-volume">{formatVolume(snapData.volume)}</span>
                                            {rankDiff !== 0 && (
                                                <span className={`snap-diff ${rankDiff < 0 ? 'up' : 'down'}`}>
                                                    {rankDiff < 0 ? `↑${Math.abs(rankDiff)}` : `↓${rankDiff}`}
                                                </span>
                                            )}
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
