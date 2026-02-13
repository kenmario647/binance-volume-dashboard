import { useState, useCallback } from 'react';

/**
 * 数値をフォーマットする関数群
 */

// USDT建て出来高のフォーマット
export function formatVolume(value) {
    if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
    return `$${value.toFixed(0)}`;
}

// 価格のフォーマット
export function formatPrice(price) {
    if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1) return price.toFixed(4);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
}

// 変動率のフォーマット
export function formatPercent(percent) {
    const sign = percent >= 0 ? '+' : '';
    return `${sign}${percent.toFixed(2)}%`;
}

// 取引回数のフォーマット
export function formatCount(count) {
    if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
    if (count >= 1e3) return `${(count / 1e3).toFixed(0)}K`;
    return count.toLocaleString();
}

// シンボルからペア名を抽出
export function parseSymbol(symbol) {
    const base = symbol.replace('USDT', '');
    return { base, quote: 'USDT' };
}

/**
 * データ取得用のカスタムフック
 */
export function useVolumeData() {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastUpdate, setLastUpdate] = useState(null);

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const apiBase = import.meta.env.DEV ? 'http://localhost:3001' : '';
            const response = await fetch(`${apiBase}/api/volume/top100`);
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);
            const result = await response.json();
            setData(result);
            setLastUpdate(new Date());
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    return { data, loading, error, lastUpdate, fetchData };
}
