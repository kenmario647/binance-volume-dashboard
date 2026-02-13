import { useState, useMemo } from 'react';
import { formatVolume, formatPrice, formatPercent, formatCount, parseSymbol } from '../utils';

function VolumeTable({ data, currency = 'USD' }) {
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

    const maxVolume = useMemo(() => {
        if (!data?.length) return 1;
        return Math.max(...data.map(d => d.quoteVolume));
    }, [data]);

    const columns = [
        { key: 'rank', label: '#', sortable: false },
        { key: 'symbol', label: '銘柄' },
        { key: 'lastPrice', label: '価格' },
        { key: 'priceChangePercent', label: '24h変動率' },
        { key: 'quoteVolume', label: '24h出来高 (USDT)' },
    ];

    const getSortClass = (key) => {
        if (sortConfig.key !== key) return '';
        return sortConfig.direction;
    };

    return (
        <div className="table-wrapper">
            <table className="volume-table">
                <thead>
                    <tr>
                        {columns.map(col => (
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
                    </tr>
                </thead>
                <tbody>
                    {sortedData.map((item, index) => {
                        const { base, quote } = parseSymbol(item.symbol);
                        const displayName = item.displayName || base;
                        const rank = index + 1;
                        const changePercent = item.priceChangePercent;
                        const changeClass = changePercent >= 0 ? 'positive' : 'negative';
                        const volPercent = Math.min((item.quoteVolume / maxVolume) * 100, 100);

                        return (
                            <tr key={item.symbol}>
                                {/* ランク */}
                                <td>
                                    <span className={`rank-badge ${rank <= 3 ? `rank-${rank}` : ''}`}>
                                        {rank}
                                    </span>
                                </td>

                                {/* 銘柄 */}
                                <td>
                                    <div className="symbol-cell">
                                        <span className="symbol-base">{displayName}</span>
                                        <span className="symbol-quote">/ {quote || 'USDT'}</span>
                                    </div>
                                </td>

                                {/* 価格 */}
                                <td className="price-cell">{formatPrice(item.lastPrice, currency)}</td>

                                {/* 変動率 */}
                                <td className={changeClass}>
                                    {formatPercent(changePercent)}
                                </td>

                                {/* 出来高（バー付き） */}
                                <td>
                                    <div className="volume-bar-container">
                                        <div
                                            className={`volume-bar ${changeClass}`}
                                            style={{ width: `${volPercent}%` }}
                                        />
                                        <span className="volume-text">
                                            {formatVolume(item.quoteVolume, currency)}
                                        </span>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

export default VolumeTable;
