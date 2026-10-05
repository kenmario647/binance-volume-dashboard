import { useState, useCallback } from 'react';

/**
 * 数値フォーマット関数群
 */

// USDT建て出来高のフォーマット
export function formatVolume(value, currency = 'USD') {
    const prefix = currency === 'KRW' ? '₩' : '$';
    if (value >= 1e12) return `${prefix}${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9) return `${prefix}${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `${prefix}${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `${prefix}${(value / 1e3).toFixed(2)}K`;
    return `${prefix}${value.toFixed(2)}`;
}

// 価格のフォーマット
export function formatPrice(price, currency = 'USD') {
    if (currency === 'KRW') {
        if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
        return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (price >= 1) return price.toFixed(4);
    if (price >= 0.01) return price.toFixed(5);
    return price.toFixed(8);
}

// 変動率のフォーマット
export function formatPercent(value) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
}

// 取引回数のフォーマット
export function formatCount(count) {
    if (!count) return '-';
    if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
    if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`;
    return count.toLocaleString();
}

// シンボル表示名のパース
export function parseSymbol(symbol) {
    const suffixes = ['USDT', 'KRW'];
    for (const suffix of suffixes) {
        if (symbol.endsWith(suffix)) {
            return {
                base: symbol.slice(0, -suffix.length),
                quote: suffix,
            };
        }
    }
    return { base: symbol, quote: '' };
}

// ── タブ定義 ──
export const TABS = [
    {
        id: 'binance-futures',
        label: 'Binance先物',
        shortLabel: 'BN先物',
        endpoint: '/api/volume/top100',
        currency: 'USD',
        icon: '₿',
        color: '#f0b90b',
        description: 'Binance USDT-M 先物',
        badgeText: 'TOP 100',
    },
    {
        id: 'bitget-spot',
        label: 'Bitget現物',
        shortLabel: 'Bitget',
        endpoint: '/api/bitget/spot/top100',
        currency: 'USD',
        icon: '🟢',
        color: '#00d991',
        description: 'Bitget 現物',
        badgeText: 'TOP 100',
    },
    {
        id: 'upbit-spot',
        label: 'Upbit現物',
        shortLabel: 'Upbit',
        endpoint: '/api/upbit/spot/top100',
        currency: 'USD',
        icon: '🟣',
        color: '#093687',
        description: 'Upbit 現物 (USD換算)',
        badgeText: 'TOP 100',
    },
    {
        id: 'binance-alpha',
        label: 'Binance Alpha',
        shortLabel: 'Alpha',
        endpoint: '/api/binance/alpha/top100',
        currency: 'USD',
        icon: '⚡',
        color: '#e040fb',
        description: 'Binance Alpha 先物',
        badgeText: 'ALPHA',
    },
    {
        id: 'momentum',
        label: '急上昇',
        shortLabel: '急上昇',
        view: 'momentum',
        icon: '🚀',
        color: '#ef4444',
        description: '15分の上昇率',
        badgeText: '15分',
    },
];

// ── データ取得カスタムフック ──
export const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

export function useExchangeData() {
    const [dataMap, setDataMap] = useState({});
    const [loadingMap, setLoadingMap] = useState({});
    const [errorMap, setErrorMap] = useState({});
    const [lastUpdateMap, setLastUpdateMap] = useState({});

    const fetchData = useCallback(async (tabId) => {
        const tab = TABS.find(t => t.id === tabId);
        if (!tab) return;

        setLoadingMap(prev => ({ ...prev, [tabId]: true }));
        setErrorMap(prev => ({ ...prev, [tabId]: null }));

        try {
            const response = await fetch(`${API_BASE}${tab.endpoint}`);
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);
            const result = await response.json();
            setDataMap(prev => ({ ...prev, [tabId]: result }));
            setLastUpdateMap(prev => ({ ...prev, [tabId]: new Date() }));
        } catch (err) {
            setErrorMap(prev => ({ ...prev, [tabId]: err.message }));
        } finally {
            setLoadingMap(prev => ({ ...prev, [tabId]: false }));
        }
    }, []);

    return { dataMap, loadingMap, errorMap, lastUpdateMap, fetchData };
}
