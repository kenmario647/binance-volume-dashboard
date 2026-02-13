import { useState, useMemo } from 'react';
import { formatVolume, formatPrice, formatPercent, formatCount, parseSymbol } from '../utils';

const COLUMNS = [
    { key: 'rank', label: '#', sortable: false },
    { key: 'symbol', label: '銘柄' },
    { key: 'lastPrice', label: '価格' },
    { key: 'priceChangePercent', label: '24h変動率' },
    { key: 'quoteVolume', label: '24h出来高 (USDT)' },
    { key: 'highPrice', label: '24h高値' },
    { key: 'lowPrice', label: '24h安値' },
    { key: 'count', label: '取引回数' },
];

function VolumeTable({ data }) {
    const [sortKey, setSortKey] = useState('quoteVolume');
    const [sortDir, setSortDir] = useState('desc');

    const handleSort = (key) => {
        if (key === 'rank') return;
        if (sortKey === key) {
            setSortDir(prev => prev === 'desc' ? 'asc' : 'desc');
        } else {
            setSortKey(key);
            setSortDir('desc');
        }
    };

    const sortedData = useMemo(() => {
        if (!data) return [];
        return [...data].sort((a, b) => {
            let aVal = a[sortKey];
            let bVal = b[sortKey];
            if (typeof aVal === 'string') {
                return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
            }
            return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
        });
    }, [data, sortKey, sortDir]);

    const maxVolume = useMemo(() => {
        if (!data || data.length === 0) return 1;
        return Math.max(...data.map(d => d.quoteVolume));
    }, [data]);

    return (
        <div className="table-container">
            <div className="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            {COLUMNS.map(col => (
                                <th
                                    key={col.key}
                                    className={sortKey === col.key ? 'active' : ''}
                                    onClick={() => col.sortable !== false && handleSort(col.key)}
                                    style={col.sortable === false ? { cursor: 'default' } : {}}
                                >
                                    {col.label}
                                    {col.sortable !== false && (
                                        <span className="sort-arrow">
                                            {sortKey === col.key ? (sortDir === 'desc' ? '▼' : '▲') : '▽'}
                                        </span>
                                    )}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {sortedData.map((item, index) => {
                            const { base } = parseSymbol(item.symbol);
                            const changeClass = item.priceChangePercent >= 0 ? 'change-positive' : 'change-negative';
                            const volPercent = (item.quoteVolume / maxVolume) * 100;
                            const rankNum = index + 1;
                            let rankClass = 'rank-default';
                            if (rankNum === 1) rankClass = 'rank-1';
                            else if (rankNum === 2) rankClass = 'rank-2';
                            else if (rankNum === 3) rankClass = 'rank-3';

                            return (
                                <tr key={item.symbol}>
                                    <td>
                                        <span className={`rank ${rankClass}`}>{rankNum}</span>
                                    </td>
                                    <td>
                                        <div className="symbol-cell">
                                            <div>
                                                <div className="symbol-name">{base}</div>
                                                <div className="symbol-pair">/ USDT</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td>{formatPrice(item.lastPrice)}</td>
                                    <td className={changeClass}>
                                        {formatPercent(item.priceChangePercent)}
                                    </td>
                                    <td>
                                        <div className="volume-cell">
                                            <span className="volume-text">{formatVolume(item.quoteVolume)}</span>
                                            <div className="volume-bar-wrapper">
                                                <div
                                                    className="volume-bar"
                                                    style={{ width: `${volPercent}%` }}
                                                />
                                            </div>
                                        </div>
                                    </td>
                                    <td>{formatPrice(item.highPrice)}</td>
                                    <td>{formatPrice(item.lowPrice)}</td>
                                    <td>{formatCount(item.count)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export default VolumeTable;
