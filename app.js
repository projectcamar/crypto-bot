function safeSetData(s, d) { if (!s || !d) return; s.setData(d.filter(x => x && x.time != null)); }
// ============================================================
// BinanceBot Terminal � Frontend Application
// ============================================================

// --- State ---
let currentSymbol = 'BTCUSDT';
let currentInterval = '5m';
let currentSide = 'BUY';
let isServerless = false;
let lastPricesObj = {};
let lastTickersObj = {};
const BINANCE_WS_MIRROR = 'wss://fstream.binance.me/ws';
const BINANCE_REST_MIRROR = 'https://fapi.binance.me/fapi/v1';
const BINANCE_REST_MAIN = 'https://fapi.binance.com/fapi/v1';

// --- Automated Trading State (Decoupled Timeframe) ---
let tradeInterval = '1m';
let tradeIntervalSecs = 60;
let isFetchingTradeKlines = false;
let lastTradeKlineFetchTime = 0;
let isFetchingHedgeKlines = false;
let lastHedgeKlineFetchTime = 0;

function ivToSec(iv) {
    if (!iv) return 60;
    const s = iv.toLowerCase();
    const val = parseInt(s);
    if (s.endsWith('s')) return val;
    if (s.endsWith('m')) return val * 60;
    if (s.endsWith('h')) return val * 3600;
    if (s.endsWith('d')) return val * 86400;
    return val * 60;
}
let currentOrderType = 'market';
let candleData = []; // Missing state added

let chart = null;
let candleSeries = null;
let volumeSeries = null;
let ema9Line = null;
let ema21Line = null;
let rsiLine = null;
let sarLine = null;
let vwapLine = null;
let supertrendLines = []; // Active segments currently on chart
let supertrendPool = { lines: [], areas: [] }; // Object pool for series reuse

let priceWs = null;
let klineWs = null;

// --- Synthetic Candle Builder State ---
let isWsConnected = false;
let synthetic1sTimer = null;  // interval timer for flushing

let symbolFilters = {};

// Robust quantity formatter: ensures precision never exceeds Binance rules
async function safeQuantity(symbol, rawQty) {
    // On-demand fetch if we don't have filters yet
    if (!symbolFilters[symbol]) {
        try {
            const r = await fetch('/api/futures/exchange-info');
            const data = await r.json();
            if (data.symbols) {
                data.symbols.forEach(s => {
                    let minNotional = 5.0;
                    const notionalFilter = s.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
                    if (notionalFilter) minNotional = parseFloat(notionalFilter.notional);
                    symbolFilters[s.symbol] = {
                        quantityPrecision: s.quantityPrecision,
                        pricePrecision: s.pricePrecision,
                        minNotional: minNotional
                    };
                });
            }
        } catch (e) {
            console.error('[safeQuantity] Failed to fetch exchange info:', e);
        }
    }
    // Use 0 as the safest fallback (whole numbers always accepted)
    const precision = symbolFilters[symbol]?.quantityPrecision ?? 0;
    return parseFloat(rawQty).toFixed(precision);
}

let isHedgeMode = false;
let balanceData = {};
let lastPrice = 0;
let lastMarkPrice = 0;
let lastPriceTime = Date.now();
let totalPnL = 0;
let tradeHistory = [];

// --- Paper Trading (Futures) State ---
let paperBalance = 1000;
let paperPositions = [];
let paperTradeHistory = []; // Track closed paper trades
let leverage = 10;

// --- Bot Config (Indicator Params) ---
let botConfig = {
    supertrend: { atrPeriod: 10, factor: 3.0 },
    parabolicSAR: { start: 0.02, increment: 0.02, max: 0.2 },
    adx: { length: 14, threshold: 25 }
};

// --- Simulation State ---
let isSimMode = false;
let simData = [];
let simIndex = 0;
let simIntervalId = null;
let lastBacktestTrades = [];
let simBalance = 1000;
let simStartBalance = 1000;
let simTrades = [];
let simActiveTrade = null;
let simSpeed = 50;

// --- SuperTrend Bot State ---
let stBotPosition = null;    // { side, entryPrice, quantity, margin, trailingSL, stLine, leverage, notional, id }
let stBotLastDirection = 0;  // 1=bullish, -1=bearish
let stBotLastCandleTime = 0; // prevent re-processing same candle
let stBotTradeCount = 0;     // total trades for session
let isStBotBusy = false;     // Lock for async operations

let tstPauseUntil = 0;       // timestamp in ms

// --- Chart Position Lines ---
let positionPriceLines = {}; // { id: IPriceLine }

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function parseLocaleFloat(val, def) {
    if (!val) return def;
    const parsed = parseFloat(String(val).replace(',', '.'));
    return isNaN(parsed) ? def : parsed;
}

// ============================================================
// INITIALIZATION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('[BinanceBot] Initializing...');
    initChart();
    initEventListeners();
    initWebSocket();

    // Initial data load
    fetchExchangeInfo();
    fetchPositionMode();
    fetchBalance();
    fetchPrices();
    loadKlines();
    fetchOrderbook();
    fetchRecentTrades();
    fetchOpenOrders();
    checkConnection();
    renderPaperPositions();

    // Periodic updates (REDUCED FOR RATE LIMIT SAFETY - Adjusted for urgency)
    setInterval(fetchBalance, 10000);
    setInterval(fetchOpenOrders, 10000);
    setInterval(fetchMarketDetailedInfo, 10000);
    setInterval(checkConnection, 15000);
    setInterval(fetchPositionMode, 60000);  // 60s
    setInterval(updateEstimates, 1000);    // 1s
    setInterval(renderScreenerTable, 30000); // 30s

    // Trade Timeframe Listener
    const tfSelect = document.getElementById('trade-timeframe');
    if (tfSelect) {
        tradeInterval = tfSelect.value;
        tradeIntervalSecs = ivToSec(tradeInterval);

        tfSelect.addEventListener('change', (e) => {
            tradeInterval = e.target.value;
            tradeIntervalSecs = ivToSec(tradeInterval);

            logEngine(`?? Trade Timeframe changed to ${tradeInterval} (${tradeIntervalSecs}s). Fetching history...`, 'info');
            fetchBackgroundTradeKlines();
        });
        // Initial fetch
        fetchBackgroundTradeKlines();

        // Periodic background history sync for trade timeframe (every 60s)
        setInterval(() => {
            if (isEngineActive) fetchBackgroundTradeKlines();
        }, 60000);
    }

    // NEW WATCHDOG: Force reconnect if no price for 15s
    setInterval(() => {
        const now = Date.now();
        const diff = now - lastPriceTime;
        if (diff > 15000 && isWsConnected) {
            console.warn(`[Watchdog] No price update for ${diff}ms. Resetting Central Hub...`);
            initCentralStream();
            lastPriceTime = now; // Prevent rapid retry
        }
    }, 5000);

    console.log('[BinanceBot] Ready.');
});

// ============================================================
// CHART (Lightweight Charts)
// ============================================================
function initChart() {
    const container = document.getElementById('chart-container');
    if (!container) return;

    chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
            background: { color: '#181a20' },
            textColor: '#848e9c',
            fontSize: 11,
            fontFamily: "'Inter', sans-serif",
        },
        grid: {
            vertLines: { color: '#2b2f3622' },
            horzLines: { color: '#2b2f3622' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: '#f0b90b44', style: 0, labelBackgroundColor: '#f0b90b' },
            horzLine: { color: '#f0b90b44', style: 0, labelBackgroundColor: '#f0b90b' },
        },
        rightPriceScale: {
            borderColor: '#2b2f36',
            scaleMargins: { top: 0.1, bottom: 0.2 },
        },
        timeScale: {
            borderColor: '#2b2f36',
            timeVisible: true,
            secondsVisible: false,
        },
        handleScroll: { vertTouchDrag: false },
    });

    // Candlestick Series
    candleSeries = chart.addCandlestickSeries({
        upColor: '#0ecb81',
        downColor: '#f6465d',
        borderDownColor: '#f6465d',
        borderUpColor: '#0ecb81',
        wickDownColor: '#f6465d88',
        wickUpColor: '#0ecb8188',
    });

    // Volume Series
    volumeSeries = chart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: '',
    });

    volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
    });

    // EMA Lines
    ema9Line = chart.addLineSeries({
        color: '#f0b90b',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
    });

    ema21Line = chart.addLineSeries({
        color: '#7b61ff',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
    });

    // RSI Line
    rsiLine = chart.addLineSeries({
        color: '#ff2d55',
        lineWidth: 1,
        priceScaleId: 'left',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
    });

    // Supertrend � dynamic colored segments created in drawIndicators

    // VWAP Line
    vwapLine = chart.addLineSeries({
        color: '#00bcd4',
        lineWidth: 2,
        lineStyle: 0,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        title: 'VWAP',
    });

    // SAR Line
    sarLine = chart.addLineSeries({
        color: '#f0b90b',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: 'SAR',
    });

    chart.priceScale('left').applyOptions({
        scaleMargins: { top: 0.7, bottom: 0 },
        visible: true,
    });

    // Resize handler
    const resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
            chart.applyOptions({
                width: entry.contentRect.width,
                height: entry.contentRect.height
            });
        }
    });
    resizeObserver.observe(container);

    // === CHART BLANK RECOVERY ===
    // When the user switches browser tabs and comes back, the chart canvas may
    // be blank. Force a re-render on visibility change without requiring a refresh.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && chart && candleData && candleData.length > 0) {
            requestAnimationFrame(() => {
                try {
                    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
                    chart.timeScale().fitContent();
                } catch (e) { }
            });
        }
    });

    // Periodic chart health watchdog: if chart appears blank (no logicalRange),
    // auto-recover by repainting without user intervention.
    setInterval(() => {
        if (!chart || !candleData || candleData.length === 0) return;
        try {
            const logRange = chart.timeScale().getVisibleLogicalRange();
            if (!logRange) {
                // Chart has lost its range � force a repaint
                chart.timeScale().fitContent();
            }
        } catch (e) { }
    }, 3000);
}

// ============================================================
// KLINE DATA (Candlesticks)
// ============================================================
async function loadKlines() {
    try {
        // One-time cache safety: Ensure synthetic intervals don't have stale 1m-length data
        if (!window.cacheWiped) {
            SYNTHETIC_INTERVALS.forEach(si => { candleCache[si] = []; });
            window.cacheWiped = true;
            console.log('[Cache] Emergency wipe of synthetic intervals performed.');
        }
        // --- CACHE CHECK ---
        // Prioritize cached data for ALL intervals (synthetic and standard).
        const ivSec = ivToSec(currentInterval);
        let cached = candleCache[ivSec];

        // Safety check for synthetic: if the gap between candles is not right, wipe it.
        if (SYNTHETIC_INTERVALS.includes(currentInterval) && cached && cached.length > 2) {
            const expectedGap = ivToSec(currentInterval);
            const actualGap = cached[1].time - cached[0].time;
            if (actualGap !== expectedGap) {
                // If it's a sub-minute interval, it's possible it's just fresh. Check if history is indeed wrong.
                if (cached.length > 50) {
                    console.warn(`[Cache] Detected invalid gap in ${currentInterval} cache (${actualGap}s vs ${expectedGap}s). Wiping...`);
                    candleCache[ivSec] = [];
                    cached = null;
                }
            }
        }

        if (cached && cached.length > 10) {
            candleData = cached.slice();
            safeSetData(candleSeries, candleData.map(k => ({
                time: k.time, open: k.open, high: k.high, low: k.low, close: k.close,
            })));
            safeSetData(volumeSeries, candleData.map(k => ({
                time: k.time, value: k.volume,
                color: k.close >= k.open ? '#0ecb8133' : '#f6465d33',
            })));
            drawIndicators(candleData);
            console.log(`[Chart] ${currentInterval}: Loaded ${cached.length} candles from cache.`);

            // If it's a standard interval, we still might want to refresh from API once to get missed gaps, 
            // but we do it SILENTLY in the background to ensure the UI feels instant.
            if (!SYNTHETIC_INTERVALS.includes(currentInterval)) {
                fetchKlinesAPI(currentInterval, true); // silent refresh
            }
            return;
        }

        // --- FETCH FROM API ---
        await fetchKlinesAPI(currentInterval, false);

    } catch (e) {
        console.error('[Klines] Global Load Error:', e);
    }
}
async function fetchKlinesAPI(interval, isSilent = false) {
    try {
        // Intercept synthetic intervals to expand from 1m
        if (SYNTHETIC_INTERVALS.includes(interval)) {
            let data1m = [];
            try {
                const r = await fetch(`/api/klines/${currentSymbol}?interval=1m&limit=500`);
                data1m = await r.json();
            } catch (e) {
                const dr = await fetch(`${BINANCE_REST_MIRROR}/klines?symbol=${currentSymbol}&interval=1m&limit=500`);
                data1m = await dr.json();
            }

            if (Array.isArray(data1m) && data1m.length > 0) {
                const transformed = transform1mToSynthetic(data1m, interval);

                // SMART MERGE: Don't just overwrite. If we have real ticks, use them for the recent part.
                const existingLive = candleCache[interval] || [];
                let finalData = transformed;

                if (existingLive.length > 0) {
                    const firstLiveTime = existingLive[0].time;
                    // Filter transformed history to only keep data BEFORE the first live tick
                    const filteredHistory = transformed.filter(h => h.time < firstLiveTime);
                    finalData = [...filteredHistory, ...existingLive];
                    console.log(`[Klines] Smart Merge for ${interval}: ${filteredHistory.length} history + ${existingLive.length} live candles.`);
                }

                candleCache[interval] = finalData;

                if (currentInterval === interval) {
                    candleData = finalData;
                    safeSetData(candleSeries, finalData.map(k => ({
                        time: k.time, open: k.open, high: k.high, low: k.low, close: k.close,
                    })));
                    safeSetData(volumeSeries, finalData.map(k => ({
                        time: k.time, value: k.volume,
                        color: k.close >= k.open ? '#0ecb8133' : '#f6465d33',
                    })));
                    drawIndicators(finalData);
                    const last = finalData[finalData.length - 1];
                    if (last) updatePriceDisplay(last.close);
                }
                return;
            }
        }

        let data = [];
        let fetchFailed = false;

        try {
            const r = await fetch(`/api/klines/${currentSymbol}?interval=${interval}&limit=500`);
            data = await r.json();
            if (data.error || !Array.isArray(data)) fetchFailed = true;
        } catch (err) {
            fetchFailed = true;
        }

        // --- HARD FALLBACK: Try Direct Binance API from Browser ---
        if (fetchFailed || data.length === 0) {
            console.warn(`?? Backend fetch failed for ${interval}, trying direct browser fallback...`);
            try {
                // Try Mirror (.me) first - better for some regions
                const dr = await fetch(`${BINANCE_REST_MIRROR}/klines?symbol=${currentSymbol}&interval=${interval}&limit=500`);
                data = await dr.json();
            } catch (e2) {
                try {
                    // Try Main domain
                    const dr2 = await fetch(`${BINANCE_REST_MAIN}/klines?symbol=${currentSymbol}&interval=${interval}&limit=500`);
                    data = await dr2.json();
                } catch (e3) {
                    console.error("?? All history fetch fallbacks failed:", e3);
                    logEngine("⚠️ Chart history failed to load (ISP Blocking?)", "error");
                    return;
                }
            }
        }

        if (!Array.isArray(data) || data.length === 0) {
            if (!isSilent) {
                candleData = [];
                safeSetData(candleSeries, []);
                safeSetData(candleSeries, []);
                drawIndicators([]);
            }
            return;
        }

        // Save to cache for future instant-switching
        candleCache[interval] = data;

        // If this is a 1m fetch, we check if we need to pre-fill any synthetic caches that are empty
        if (interval === '1m') {
            SYNTHETIC_INTERVALS.forEach(si => {
                if (si === '2m' || si.endsWith('s')) {
                    if (!candleCache[si] || candleCache[si].length < 10) {
                        candleCache[si] = transform1mToSynthetic(data, si);
                        console.log(`[Cache] Pre-filled ${si} from 1m history (${candleCache[si].length} candles)`);
                    }
                }
            });
        }

        // Update active chart state only if the interval hasn't changed while we were fetching
        if (currentInterval === interval) {
            candleData = data;
            safeSetData(candleSeries, data.map(k => ({
                time: k.time, open: k.open, high: k.high, low: k.low, close: k.close,
            })));
            safeSetData(volumeSeries, data.map(k => ({
                time: k.time, value: k.volume,
                color: k.close >= k.open ? '#0ecb8133' : '#f6465d33',
            })));
            drawIndicators(data);
            const last = data[data.length - 1];
            if (last) updatePriceDisplay(last.close);
        }
    } catch (e) {
        if (!isSilent) console.error(`[Klines] API Error (${interval}):`, e);
    }
}

function transform1mToSynthetic(data1m, targetInterval) {
    const targetSec = ivToSec(targetInterval);
    if (targetSec === 60) return data1m;

    console.log(`[Transform] ${targetInterval} from 1m history (${data1m.length} candles). TargetSec: ${targetSec}`);
    const results = [];
    if (targetSec < 60) {
        const ratio = 60 / targetSec;
        for (const k of data1m) {
            for (let i = 0; i < ratio; i++) {
                results.push({
                    time: k.time + (i * targetSec),
                    open: k.open, high: k.high, low: k.low, close: k.close,
                    volume: k.volume / ratio
                });
            }
        }
    } else if (targetSec >= 120) {
        // Multi-minute aggregation (e.g. 2m)
        const factor = Math.floor(targetSec / 60);

        // Find the first candle that aligns to a boundary (e.g. even minute for 2m)
        let startIdx = 0;
        while (startIdx < data1m.length) {
            const minute = Math.floor(data1m[startIdx].time / 60);
            if (minute % factor === 0) break;
            startIdx++;
        }

        for (let i = startIdx; i < data1m.length; i += factor) {
            const group = data1m.slice(i, i + factor);
            if (group.length < factor) break;
            results.push({
                time: group[0].time,
                open: group[0].open,
                high: Math.max(...group.map(g => g.high)),
                low: Math.min(...group.map(g => g.low)),
                close: group[group.length - 1].close,
                volume: group.reduce((acc, g) => acc + g.volume, 0)
            });
        }
    }
    console.log(`[Transform] Generated ${results.length} candles for ${targetInterval}`);
    return results;
}

async function fetchBackgroundHedgeKlines() {
    const hedgeTfSecs = parseInt(document.getElementById('cfg-hedge-tf')?.value || '60');
    let interval = '1m';
    if (hedgeTfSecs === 1) interval = '1s';
    else if (hedgeTfSecs === 3) interval = '3s';
    else if (hedgeTfSecs === 5) interval = '5s';
    else if (hedgeTfSecs === 10) interval = '10s';
    else if (hedgeTfSecs === 15) interval = '15s';
    else if (hedgeTfSecs === 20) interval = '20s';
    else if (hedgeTfSecs === 30) interval = '30s';
    else if (hedgeTfSecs === 180) interval = '3m';
    else if (hedgeTfSecs === 300) interval = '5m';
    else if (hedgeTfSecs === 900) interval = '15m';

    if (isFetchingHedgeKlines) return;
    const now = Date.now();
    if (now - lastHedgeKlineFetchTime < 60000) return; // 60s cooldown

    isFetchingHedgeKlines = true;
    lastHedgeKlineFetchTime = now;

    try {
        const fetchInterval = (interval === '2m' || interval.endsWith('s')) ? '1m' : interval;
        const r = await fetch(`/api/klines/${currentSymbol}?interval=${fetchInterval}&limit=500`);
        const data = await r.json();
        if (Array.isArray(data) && data.length > 0) {
            let processed = data;
            if (fetchInterval === '1m' && interval !== '1m') {
                processed = transform1mToSynthetic(data, interval);
            }

            // MERGE logic: Don't just overwrite. Prevent wiping live candles that might have arrived during fetch.
            const existing = candleCache[hedgeTfSecs] || [];
            if (existing.length > 5) {
                // If we already have live data, only add if history is actually older
                const lastHistory = processed[processed.length - 1].time;
                const firstLive = existing[0].time;
                if (lastHistory < firstLive) {
                    candleCache[hedgeTfSecs] = [...processed, ...existing];
                } else {
                    // Overlap check: filter out data from history that's already in live
                    const filteredHistory = processed.filter(h => h.time < firstLive);
                    candleCache[hedgeTfSecs] = [...filteredHistory, ...existing];
                }
            } else {
                candleCache[hedgeTfSecs] = processed;
            }

            if (candleCache[hedgeTfSecs].length > 1000) {
                candleCache[hedgeTfSecs] = candleCache[hedgeTfSecs].slice(-1000);
            }

            console.log(`[Hedge] Consolidated ${candleCache[hedgeTfSecs].length} candles for ${interval}`);
        }
    } catch (e) {
        console.error('[Hedge] Failed to fetch background history:', e);
    } finally {
        isFetchingHedgeKlines = false;
    }
}

async function fetchBackgroundTradeKlines() {
    if (isFetchingTradeKlines) return;
    const now = Date.now();
    const cooldown = 60000; // 60s
    if (now - lastTradeKlineFetchTime < cooldown) {
        if (Math.floor(now / 1000) % 30 === 0) console.log(`[Engine] Skipping background fetch (cooldown: ${((cooldown - (now - lastTradeKlineFetchTime)) / 1000).toFixed(0)}s)`);
        return;
    }

    isFetchingTradeKlines = true;
    lastTradeKlineFetchTime = now;

    console.log(`[Engine] Fetching background history for Trade TF: ${tradeInterval} symbol: ${currentSymbol}`);
    let interval = tradeInterval;

    try {
        // For intervals that are not standard Binance intervals, we might need 1m klines
        const standardIntervals = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
        const isStandard = standardIntervals.includes(interval);
        const fetchInterval = isStandard ? interval : '1m';

        const r = await fetch(`/api/klines/${currentSymbol}?interval=${fetchInterval}&limit=1000`);
        const data = await r.json();
        if (Array.isArray(data) && data.length > 0) {
            let processed = data;
            if (!isStandard) {
                processed = transform1mToSynthetic(data, interval);
            }

            const existing = candleCache[tradeIntervalSecs] || [];
            if (existing.length > 5) {
                const firstLive = existing[0].time;
                const filteredHistory = processed.filter(h => h.time < firstLive);
                candleCache[tradeIntervalSecs] = [...filteredHistory, ...existing];
            } else {
                candleCache[tradeIntervalSecs] = processed;
            }

            if (candleCache[tradeIntervalSecs].length > 1500) {
                candleCache[tradeIntervalSecs] = candleCache[tradeIntervalSecs].slice(-1500);
            }

            logEngine(`⚡ Trade history loaded: ${candleCache[tradeIntervalSecs].length} candles for ${interval}`, 'success');
        }
    } catch (e) {
        logEngine(`? Failed to fetch trade history: ${e.message}`, 'error');
        console.error('[Engine] History fetch error:', e);
    } finally {
        isFetchingTradeKlines = false;
    }
}

function drawIndicators(data) {
    if (!data || data.length === 0) return;

    // --- Performance Throttling ---
    const now = Date.now();
    const activeIv = currentInterval;
    const isSynthetic = SYNTHETIC_INTERVALS.includes(activeIv);

    // Strict 1s throttle for all indicator draws to prevent main-thread freeze
    if (now - lastIndicatorDrawTime < 1000) return;

    // Skip if price hasn't moved (prevents redundant redraws on 100ms synthetic timer)
    if (lastPrice === lastPriceProcessedForIndicators && !isSynthetic) return;

    lastIndicatorDrawTime = now;
    lastPriceProcessedForIndicators = lastPrice;

    const closes = data.map(k => k.close);
    const times = data.map(k => k.time);

    // EMA
    if (document.getElementById('toggle-ema')?.checked) {
        const ema9Data = calcEMA(closes, 9).map((v, i) => ({ time: times[i], value: v })).filter(d => d.value !== null);
        const ema21Data = calcEMA(closes, 21).map((v, i) => ({ time: times[i], value: v })).filter(d => d.value !== null);
        safeSetData(ema9Line, ema9Data);
        safeSetData(ema21Line, ema21Data);
    } else {
        safeSetData(candleSeries, []);
        safeSetData(candleSeries, []);
    }

    // RSI
    if (document.getElementById('toggle-rsi')?.checked) {
        const rsiData = calcRSI(closes, 14).map((v, i) => ({ time: times[i], value: v })).filter(d => d.value !== null);
        safeSetData(rsiLine, rsiData);
    } else {
        safeSetData(candleSeries, []);
    }

    // SAR
    if (document.getElementById('toggle-sar')?.checked) {
        const afStart = parseLocaleFloat(document.getElementById('cfg-st-sar-af-start')?.value, 0.02);
        const afStep = parseLocaleFloat(document.getElementById('cfg-st-sar-af-step')?.value, 0.02);
        const afMax = parseLocaleFloat(document.getElementById('cfg-st-sar-af-max')?.value, 0.2);
        const psar = calcParabolicSAR(data, afStart, afStep, afMax);
        const sarData = psar.sar.map((v, i) => ({ time: times[i], value: v })).filter(d => d && d.value !== null && !isNaN(d.value));
        safeSetData(sarLine, sarData);
    } else {
        safeSetData(candleSeries, []);
    }

    // --- Supertrend Optimized Rendering (Series Pooling) ---
    // Hide all active segments first by clearing their data
    supertrendLines.forEach(s => safeSetData(candleSeries, []));
    supertrendLines = [];

    if (document.getElementById('toggle-supertrend')?.checked && data.length > 11) {
        const segments = calcSupertrend(data, 10, 3);
        let lineIdx = 0;
        let areaIdx = 0;

        for (const seg of segments) {
            const fillColor = seg.color === '#0ecb81' ? 'rgba(14,203,129,0.08)' : 'rgba(246,70,93,0.08)';
            const topColor = seg.color === '#0ecb81' ? 'rgba(14,203,129,0.18)' : 'rgba(246,70,93,0.18)';

            // Get or create Line Series
            let line = supertrendPool.lines[lineIdx];
            if (!line) {
                line = chart.addLineSeries({
                    lineWidth: 2,
                    priceLineVisible: false,
                    lastValueVisible: false,
                    crosshairMarkerVisible: false,
                });
                supertrendPool.lines.push(line);
            }
            line.applyOptions({ color: seg.color }); safeSetData(line, seg.data);
            supertrendLines.push(line);
            lineIdx++;

            // Get or create Area Series for fill
            if (seg.data.length >= 2) {
                let area = supertrendPool.areas[areaIdx];
                if (!area) {
                    area = chart.addAreaSeries({
                        bottomColor: 'transparent',
                        lineColor: 'transparent',
                        lineWidth: 0,
                        priceLineVisible: false,
                        lastValueVisible: false,
                        crosshairMarkerVisible: false,
                    });
                    supertrendPool.areas.push(area);
                }
                area.applyOptions({ topColor: topColor });
                safeSetData(area, seg.data);
                supertrendLines.push(area);
                areaIdx++;
            }
        }
    }

    // VWAP Line
    if (document.getElementById('toggle-vwap')?.checked && data.length > 5) {
        const vwapData = calcVWAP(data).map((v, i) => ({ time: times[i], value: v })).filter(d => d.value !== null && !isNaN(d.value));
        safeSetData(vwapLine, vwapData);
    } else {
        safeSetData(candleSeries, []);
    }
}

function calcEMA(prices, period) {
    const result = [];
    const multiplier = 2 / (period + 1);
    let ema = null;

    for (let i = 0; i < prices.length; i++) {
        if (i < period - 1) {
            result.push(null);
        } else if (i === period - 1) {
            ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
            result.push(ema);
        } else {
            ema = (prices[i] - ema) * multiplier + ema;
            result.push(ema);
        }
    }
    return result;
}

function calcSupertrend(data, period = 10, multiplier = 3) {
    // Returns array of { color, data } segments for colored line rendering
    if (data.length < period + 1) return [];

    // 1. Calculate True Range
    let tr = [];
    for (let i = 0; i < data.length; i++) {
        if (i === 0) {
            tr.push(data[i].high - data[i].low);
        } else {
            tr.push(Math.max(
                data[i].high - data[i].low,
                Math.abs(data[i].high - data[i - 1].close),
                Math.abs(data[i].low - data[i - 1].close)
            ));
        }
    }

    // 2. Calculate ATR (RMA/Wilder smoothing)
    let atr = new Array(data.length).fill(null);
    atr[period - 1] = tr.slice(0, period).reduce((a, b) => a + b) / period;
    for (let i = period; i < data.length; i++) {
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }

    // 3. Calculate Supertrend bands
    let finalUpper = new Array(data.length).fill(null);
    let finalLower = new Array(data.length).fill(null);
    let direction = new Array(data.length).fill(1); // 1=UP, -1=DOWN
    let stValue = new Array(data.length).fill(null); // the actual supertrend line value

    for (let i = period; i < data.length; i++) {
        let hl2 = (data[i].high + data[i].low) / 2;
        let basicUpper = hl2 + (multiplier * atr[i]);
        let basicLower = hl2 - (multiplier * atr[i]);

        // Final upper band
        if (i === period) {
            finalUpper[i] = basicUpper;
        } else {
            finalUpper[i] = (basicUpper < finalUpper[i - 1] || data[i - 1].close > finalUpper[i - 1])
                ? basicUpper : finalUpper[i - 1];
        }

        // Final lower band
        if (i === period) {
            finalLower[i] = basicLower;
        } else {
            finalLower[i] = (basicLower > finalLower[i - 1] || data[i - 1].close < finalLower[i - 1])
                ? basicLower : finalLower[i - 1];
        }

        // Direction
        if (i === period) {
            direction[i] = data[i].close > finalUpper[i] ? 1 : -1;
        } else {
            let prev = direction[i - 1];
            if (prev === 1 && data[i].close < finalLower[i]) {
                direction[i] = -1;
            } else if (prev === -1 && data[i].close > finalUpper[i]) {
                direction[i] = 1;
            } else {
                direction[i] = prev;
            }
        }

        // Supertrend value: UP trend = lower band, DOWN trend = upper band
        stValue[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i];
    }

    // 4. Build colored segments: split at each direction change
    let segments = [];
    let currentSeg = null;

    for (let i = period; i < data.length; i++) {
        if (stValue[i] === null) continue;
        let color = direction[i] === 1 ? '#0ecb81' : '#f6465d'; // green UP, red DOWN

        if (!currentSeg || currentSeg.color !== color) {
            // When switching color, overlap the last point of old segment
            // onto the first point of new segment for continuity
            if (currentSeg) {
                // Add bridge point: same time, same value, but new color
                currentSeg = { color, data: [{ time: data[i].time, value: stValue[i] }] };
                // Also push the previous point in old color to connect
                if (segments.length > 0) {
                    let prevSeg = segments[segments.length - 1];
                    // duplicate the transition point onto old segment for visual continuity
                    prevSeg.data.push({ time: data[i].time, value: stValue[i] });
                }
            } else {
                currentSeg = { color, data: [{ time: data[i].time, value: stValue[i] }] };
            }
            segments.push(currentSeg);
        } else {
            currentSeg.data.push({ time: data[i].time, value: stValue[i] });
        }
    }

    return segments;
}

// ============================================================
// SUPERTREND RAW CALCULATION (for bot engine � no chart segments)
// ============================================================
// ATR (Average True Range) calculator - Wilder smoothing
function calcATRValue(data, period = 14) {
    const atrArr = calcATR(data, period);
    return atrArr ? atrArr[atrArr.length - 1] : null;
}

function calcATR(data, period = 14) {
    const len = data.length;
    if (len < period + 1) return null;
    let tr = [];
    for (let i = 0; i < len; i++) {
        if (i === 0) { tr.push(data[i].high - data[i].low); }
        else {
            tr.push(Math.max(
                data[i].high - data[i].low,
                Math.abs(data[i].high - data[i - 1].close),
                Math.abs(data[i].low - data[i - 1].close)
            ));
        }
    }
    let atrArr = new Array(len).fill(null);
    let atr = tr.slice(0, period).reduce((a, b) => a + b) / period;
    atrArr[period - 1] = atr;
    for (let i = period; i < len; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
        atrArr[i] = atr;
    }
    return atrArr;
}


function calcSupertrendRaw(data, period = 10, multiplier = 3) {
    // Returns { direction[], stValue[] } arrays parallel to data
    const len = data.length;
    const result = { direction: new Array(len).fill(0), stValue: new Array(len).fill(null) };
    if (len < period + 1) return result;

    // 1. True Range
    let tr = [];
    for (let i = 0; i < len; i++) {
        if (i === 0) {
            tr.push(data[i].high - data[i].low);
        } else {
            tr.push(Math.max(
                data[i].high - data[i].low,
                Math.abs(data[i].high - data[i - 1].close),
                Math.abs(data[i].low - data[i - 1].close)
            ));
        }
    }

    // 2. ATR (Wilder smoothing)
    let atr = new Array(len).fill(null);
    atr[period - 1] = tr.slice(0, period).reduce((a, b) => a + b) / period;
    for (let i = period; i < len; i++) {
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }

    // 3. Supertrend bands
    let finalUpper = new Array(len).fill(null);
    let finalLower = new Array(len).fill(null);
    let direction = new Array(len).fill(1);
    let stValue = new Array(len).fill(null);

    for (let i = period; i < len; i++) {
        let hl2 = (data[i].high + data[i].low) / 2;
        let basicUpper = hl2 + (multiplier * atr[i]);
        let basicLower = hl2 - (multiplier * atr[i]);

        if (i === period) {
            finalUpper[i] = basicUpper;
        } else {
            finalUpper[i] = (basicUpper < finalUpper[i - 1] || data[i - 1].close > finalUpper[i - 1])
                ? basicUpper : finalUpper[i - 1];
        }

        if (i === period) {
            finalLower[i] = basicLower;
        } else {
            finalLower[i] = (basicLower > finalLower[i - 1] || data[i - 1].close < finalLower[i - 1])
                ? basicLower : finalLower[i - 1];
        }

        if (i === period) {
            direction[i] = data[i].close > finalUpper[i] ? 1 : -1;
        } else {
            let prev = direction[i - 1];
            if (prev === 1 && data[i].close < finalLower[i]) {
                direction[i] = -1;
            } else if (prev === -1 && data[i].close > finalUpper[i]) {
                direction[i] = 1;
            } else {
                direction[i] = prev;
            }
        }

        stValue[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i];
    }

    result.direction = direction;
    result.stValue = stValue;
    return result;
}

function calcRSI(data, period = 14) {
    let result = new Array(data.length).fill(null);
    if (data.length <= period) return result;

    let gains = 0, losses = 0;

    // First RSI value
    for (let i = 1; i <= period; i++) {
        let change = data[i].close - data[i - 1].close;
        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    if (avgLoss === 0) result[period] = 100;
    else {
        let rs = avgGain / avgLoss;
        result[period] = 100 - (100 / (1 + rs));
    }

    // Smoothed subsequent values (Wilder's Smoothing)
    for (let i = period + 1; i < data.length; i++) {
        let change = data[i].close - data[i - 1].close;
        let gain = change > 0 ? change : 0;
        let loss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        if (avgLoss === 0) {
            result[i] = 100;
        } else {
            let rs = avgGain / avgLoss;
            result[i] = 100 - (100 / (1 + rs));
        }
    }
    return result;
}

function calcStochastic(prices, kPeriod = 14, dPeriod = 3) {
    const n = prices.length;
    let kArr = new Array(n).fill(null);
    let dArr = new Array(n).fill(null);
    if (n < kPeriod) return { k: kArr, d: dArr };
    for (let i = kPeriod - 1; i < n; i++) {
        const slice = prices.slice(i - kPeriod + 1, i + 1);
        const low = Math.min(...slice);
        const high = Math.max(...slice);
        if (high === low) kArr[i] = 50;
        else kArr[i] = ((prices[i] - low) / (high - low)) * 100;
    }
    for (let i = kPeriod + dPeriod - 2; i < n; i++) {
        const slice = kArr.slice(i - dPeriod + 1, i + 1);
        if (slice.every(v => v !== null)) dArr[i] = slice.reduce((a, b) => a + b, 0) / dPeriod;
    }
    return { k: kArr, d: dArr };
}

function calcStochasticRSI(prices, rsiPeriod = 14, stochPeriod = 14, kLimit = 3, dLimit = 3) {
    const rsi = calcRSI(prices.map(p => ({ close: p })), rsiPeriod);
    const validRsi = rsi.filter(v => v !== null);
    const n = prices.length;
    let kArr = new Array(n).fill(null);
    let dArr = new Array(n).fill(null);
    if (validRsi.length < stochPeriod) return { k: kArr, d: dArr };
    const rsiOffset = n - validRsi.length;
    for (let i = rsiOffset + stochPeriod - 1; i < n; i++) {
        const slice = rsi.slice(i - stochPeriod + 1, i + 1);
        const low = Math.min(...slice);
        const high = Math.max(...slice);
        if (high === low) kArr[i] = 50;
        else kArr[i] = ((rsi[i] - low) / (high - low)) * 100;
    }
    for (let i = rsiOffset + stochPeriod + kLimit - 2; i < n; i++) {
        const slice = kArr.slice(i - kLimit + 1, i + 1);
        if (slice.every(v => v !== null)) kArr[i] = slice.reduce((a, b) => a + b, 0) / kLimit;
    }
    for (let i = rsiOffset + stochPeriod + kLimit + dLimit - 3; i < n; i++) {
        const slice = kArr.slice(i - dLimit + 1, i + 1);
        if (slice.every(v => v !== null)) dArr[i] = slice.reduce((a, b) => a + b, 0) / dLimit;
    }
    return { k: kArr, d: dArr };
}

function calcBollingerBands(prices, period = 20, multiplier = 2) {
    const n = prices.length;
    let middle = new Array(n).fill(null);
    let upper = new Array(n).fill(null);
    let lower = new Array(n).fill(null);
    if (n < period) return { middle, upper, lower };
    for (let i = period - 1; i < n; i++) {
        const slice = prices.slice(i - period + 1, i + 1);
        const avg = slice.reduce((a, b) => a + b, 0) / period;
        const stdDev = Math.sqrt(slice.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / period);
        middle[i] = avg;
        upper[i] = avg + (multiplier * stdDev);
        lower[i] = avg - (multiplier * stdDev);
    }
    return { middle, upper, lower };
}

function calcVWAP(data) {
    let vwap = new Array(data.length).fill(null);
    let cumulativePV = 0;
    let cumulativeVol = 0;
    let lastDate = null;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const date = new Date(d.time * 1000).toDateString();
        if (date !== lastDate) {
            cumulativePV = 0;
            cumulativeVol = 0;
            lastDate = date;
        }
        const typicalPrice = (d.high + d.low + d.close) / 3;
        cumulativePV += typicalPrice * d.volume;
        cumulativeVol += d.volume;
        vwap[i] = cumulativeVol === 0 ? typicalPrice : cumulativePV / cumulativeVol;
    }
    return vwap;
}

function calcHeikinAshi(data) {
    const n = data.length;
    let ha = new Array(n).fill(null);
    if (n === 0) return ha;
    let prevOpen = data[0].open;
    let prevClose = data[0].close;
    for (let i = 0; i < n; i++) {
        const d = data[i];
        const close = (d.open + d.high + d.low + d.close) / 4;
        const open = (prevOpen + prevClose) / 2;
        ha[i] = {
            time: d.time, open, high: Math.max(d.high, open, close), low: Math.min(d.low, open, close), close
        };
        prevOpen = open;
        prevClose = close;
    }
    return ha;
}

function calcMACD(prices, fast = 12, slow = 26, signal = 9) {
    const fastEMA = calcEMA(prices, fast);
    const slowEMA = calcEMA(prices, slow);
    const n = prices.length;
    let macdLine = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (fastEMA[i] !== null && slowEMA[i] !== null) macdLine[i] = fastEMA[i] - slowEMA[i];
    }
    const macdValid = macdLine.filter(v => v !== null);
    const signalLine = new Array(n).fill(null);
    if (macdValid.length >= signal) {
        const sigEMA = calcEMA(macdValid, signal);
        const offset = n - macdValid.length;
        for (let j = 0; j < sigEMA.length; j++) {
            if (sigEMA[j] !== null) signalLine[j + offset] = sigEMA[j];
        }
    }
    let histogram = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (macdLine[i] !== null && signalLine[i] !== null) histogram[i] = macdLine[i] - signalLine[i];
    }
    return { macd: macdLine, signal: signalLine, histogram: histogram };
}

// ============================================================
// WEBSOCKET � Real-time Price Stream
// ============================================================
let tstLastCandleTime = 0;
let lastScalpTradeTime = 0;
let isEngineActive = false;
let engineTradeMode = 'sim'; // 'sim' or 'real'

function initWebSocket() {
    connectPriceWs();
    connectKlineWs();
    connectOrderbookWs();
    connectTickerWs();
    connectHedgeKlineWs();
    fetchBackgroundHedgeKlines();
}

// ---- Synthetic N-second Candle Builder ----
// Supports 1s, 5s, 10s, 20s, 30s via aggTrade stream
const SYNTHETIC_SECS = [1, 3, 5, 10, 15, 20, 30, 60, 120, 180, 300, 420, 900, 3600, 14400, 86400];
const SYNTHETIC_INTERVALS = ['1s', '3s', '5s', '10s', '15s', '20s', '30s', '1m', '2m', '3m', '5m', '7m', '15m', '1h', '4h', '1d', '3D', '1W', '1M'];
let last1sFlushTime = 0;

// Parallel candle cache: keeps candle arrays for ALL sub-minute intervals simultaneously
const candleCache = {};
const openCandles = {};  // Currently building candle per interval
SYNTHETIC_SECS.forEach(sec => { candleCache[sec] = []; openCandles[sec] = null; });

function getBucketSec(timestampMs, intervalSec) {
    const sec = Math.floor(timestampMs / 1000);
    return Math.floor(sec / intervalSec) * intervalSec;
}

function getSyntheticBucketSec(timestampMs) {
    const n = ivToSec(currentInterval) || 1;
    return getBucketSec(timestampMs, n);
}

function commitCandle(candle) {
    try {
        const lastCandle = candleData[candleData.length - 1];

        // Safety lock: lightweight-charts crashes if you feed it an older chronological time.
        if (lastCandle && candle.time < lastCandle.time) {
            return;
        }

        candleSeries.update(candle);
        volumeSeries.update({
            time: candle.time,
            value: candle.volume,
            color: candle.close >= candle.open ? '#0ecb8133' : '#f6465d33',
        });

        if (lastCandle && lastCandle.time === candle.time) {
            candleData[candleData.length - 1] = candle;
        } else {
            candleData.push(candle);
            if (candleData.length > 500) candleData.shift();
        }

        // Trigger bots on every committed candle
        handleSuperTrendBot();
        handleTripleStRsiBot();
        handlePureSuperTrendBot();
        handleVWAPMomentumBot();
        handleMACDTrendBot();
        handleBollingerMeanRevBot();
        handleStochVWAPBot();
        handleHeikinAshiBot();
        handlePureSARBot();
        handlePureRSIBot();
        handlePureEMABot();
        handlePureRsiEmaBot();
        handleStSarAdxBot();
        handleComboBot();
        handleRsiEmaPivotBot();
    } catch (e) {
        console.warn('[Chart] commitCandle rejected temporal misorder:', e.message);
    }
}

function flushActiveCandle() {
    const activeN = ivToSec(currentInterval) || 1;
    const candle = openCandles[activeN];
    if (!candle) return;

    // Safety copy and reset if it's the active chart interval
    const candleToCommit = { ...candle };
    openCandles[activeN] = null;
    commitCandle(candleToCommit);
    last1sFlushTime = candleToCommit.time;
}

function fillGapCandles(upToSec) {
    // Deprecated
}

let latestBinanceTimeMs = 0;
let localTimeAtBinanceTick = 0;

function feed1sTick(price, qty, timestampMs) {
    if (timestampMs > latestBinanceTimeMs) {
        latestBinanceTimeMs = timestampMs;
        localTimeAtBinanceTick = Date.now();
    }

    const activeIntervalSec = ivToSec(currentInterval) || 1;
    let anyTradeUpdate = false;

    SYNTHETIC_SECS.forEach((ivSec) => {
        const bucket = getBucketSec(timestampMs, ivSec);
        let oc = openCandles[ivSec];

        if (!oc) {
            const cache = candleCache[ivSec];
            if (cache && cache.length > 0) {
                const last = cache[cache.length - 1];
                if (bucket === last.time) {
                    openCandles[ivSec] = { ...last };
                    oc = openCandles[ivSec];
                }
            }
        }

        if (!oc || oc.time !== bucket) {
            // New bucket starting
            if (oc) {
                const cache = candleCache[ivSec];
                if (cache && Array.isArray(cache)) {
                    if (cache.length > 0 && cache[cache.length - 1].time === oc.time) {
                        cache[cache.length - 1] = { ...oc };
                    } else {
                        cache.push({ ...oc });
                        if (cache.length > 2000) cache.shift();
                    }
                } else if (!cache) {
                    candleCache[ivSec] = [{ ...oc }];
                }
            }
            openCandles[ivSec] = {
                time: bucket, open: price, high: price, low: price, close: price, volume: qty
            };
        } else {
            // Update existing bucket
            oc.high = Math.max(oc.high, price);
            oc.low = Math.min(oc.low, price);
            oc.close = price;
            oc.volume += qty;
        }

        // Always sync the parallel cache so bots see every tick immediately
        const activeCache = candleCache[ivSec];
        if (activeCache && activeCache.length > 0) {
            const last = activeCache[activeCache.length - 1];
            if (last.time === bucket) {
                activeCache[activeCache.length - 1] = { ...openCandles[ivSec] };
            } else {
                activeCache.push({ ...openCandles[ivSec] });
                if (activeCache.length > 2000) activeCache.shift();
            }
        } else if (activeCache) {
            activeCache.push({ ...openCandles[ivSec] });
        }

        if (ivSec === tradeIntervalSecs) anyTradeUpdate = true;

        // HARD FIX: If this is the ACTIVE chart interval, update UI on EVERY tick
        if (ivSec === activeIntervalSec) {
            const candle = openCandles[ivSec];
            candleSeries.update(candle);
            volumeSeries.update({
                time: candle.time,
                value: candle.volume,
                color: candle.close >= candle.open ? '#0ecb8133' : '#f6465d33',
            });

            // Update global candleData for chart indicators
            const lastCandle = candleData[candleData.length - 1];
            if (lastCandle && lastCandle.time === candle.time) {
                candleData[candleData.length - 1] = { ...candle };
            } else {
                candleData.push({ ...candle });
                if (candleData.length > 2000) candleData.shift();
            }

            // Also update the short-term indicators for the chart
            if (candleData.length > 0) {
                const now = Date.now();
                if (!window._lastFeedDraw || now - window._lastFeedDraw > 1000) {
                    try {
                        drawIndicators(candleData);
                        window._lastFeedDraw = now;
                    } catch (e) {
                        console.warn('[Chart] drawIndicators error:', e);
                    }
                }
            }
        }
    });

    // Strategy logic pulse for background trading
    // THROTTLE: Only run strategies at most once per 500ms to prevent UI lockup 
    // during high volatility, even if trade interval is 1s.
    const now_strat = Date.now();
    if (anyTradeUpdate && isEngineActive) {
        if (!window._lastStratPulse || now_strat - window._lastStratPulse > 500) {
            handleAllStrategies();
            window._lastStratPulse = now_strat;
        }
    }
}

function start1sBuilder() {
    stop1sBuilder();
    latestBinanceTimeMs = 0;
    localTimeAtBinanceTick = 0;

    synthetic1sTimer = setInterval(() => {
        if (latestBinanceTimeMs === 0) return;

        const currentVirtualTimeMs = latestBinanceTimeMs + (Date.now() - localTimeAtBinanceTick);
        const activeN = ivToSec(currentInterval) || 1;

        // Flush ALL caches when their candle boundary has passed
        SYNTHETIC_SECS.forEach(ivSec => {
            const bucket = Math.floor(Math.floor(currentVirtualTimeMs / 1000) / ivSec) * ivSec;
            const oc = openCandles[ivSec];
            if (oc && oc.time < bucket) {
                const cache = candleCache[ivSec];
                if (!cache) return; // Guard against undefined cache during switch

                const last = cache[cache.length - 1];
                if (last && last.time === oc.time) {
                    cache[cache.length - 1] = { ...oc };
                } else {
                    cache.push({ ...oc });
                    if (cache.length > 2000) cache.shift();
                }
                openCandles[ivSec] = null;
            }
        });

        // Active interval: also flush to chart if boundary crossed
        const isSyntheticChart = SYNTHETIC_INTERVALS.includes(currentInterval);
        const ocActive = openCandles[activeN];
        if (isSyntheticChart && ocActive && ocActive.time < Math.floor(Math.floor(currentVirtualTimeMs / 1000) / activeN) * activeN) {
            flushActiveCandle();
            if (candleData.length > 0) drawIndicators(candleData);
        }
    }, 100);
}

function stop1sBuilder() {
    if (synthetic1sTimer) { clearInterval(synthetic1sTimer); synthetic1sTimer = null; }
    last1sFlushTime = 0;
}

// ?? CENTRAL SYNC HUB CLIENT
let centralStream = null;
function initCentralStream() {
    if (centralStream) { centralStream.close(); centralStream = null; }

    console.log("?? Connecting to Central Sync Hub...");
    centralStream = new EventSource('/api/stream/market');

    centralStream.onopen = () => {
        console.log("? Central Sync Hub Connected");
        isWsConnected = true;
        if (typeof notifyActiveContext === 'function') notifyActiveContext();
    };
    centralStream.onerror = (e) => {
        console.error("? Central Sync Hub Error:", e);
        isWsConnected = false;

        // If we are in serverless mode (Vercel) or the local hub is completely down,
        // fallback to direct Binance WebSockets from the browser.
        if (isServerless) {
            console.warn("?? Serverless mode detected: Initializing Direct Binance Connection...");
            initDirectBinanceWs();
        } else {
            setTimeout(initCentralStream, 5000);
        }
    };

    centralStream.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);

            if (msg.type === 'ticker_all') {
                // Bulk update for market browser
                if (msg.prices) {
                    lastPricesObj = msg.prices;
                    renderWatchlist(lastPricesObj, lastTickersObj);
                }
            }

            else if (msg.type === 'aggTrade') {
                if (msg.symbol !== currentSymbol) return;
                const price = parseFloat(msg.price);
                const qty = parseFloat(msg.qty);
                const ts = msg.time;
                const data = { p: msg.price, q: msg.qty, T: msg.time, m: msg.m };

                lastPrice = price;
                lastPriceTime = Date.now();

                // Prioritize UI Card update (Mark Price & Live Price)
                updatePriceDisplay(price);
                updateRecentTradesFromWs(data);

                // Strategy logic on every tick (throttled inside feed1sTick)
                if (stBotPosition && isEngineActive) {
                    const pos = stBotPosition;
                    if ((pos.side === 'LONG' && price <= pos.trailingSL) || (pos.side === 'SHORT' && price >= pos.trailingSL)) {
                        handleSuperTrendBot();
                    }
                    evaluateSmartHedge(price);
                }
                feed1sTick(price, qty, ts);
            }

            else if (msg.type === 'depth') {
                if (msg.symbol !== currentSymbol) return;
                renderOrderbookFromWs(msg.data);
            }

            else if (msg.type === 'kline') {
                if (msg.symbol !== currentSymbol) return;
                const k = msg.data;
                const candle = {
                    time: Math.floor(k.t / 1000),
                    open: parseFloat(k.o),
                    high: parseFloat(k.h),
                    low: parseFloat(k.l),
                    close: parseFloat(k.c),
                    volume: parseFloat(k.v)
                };

                const interval = msg.interval.toLowerCase();
                const hedgeTfSecs = parseInt(document.getElementById('cfg-hedge-tf')?.value || '60');
                const tfMap = { 60: '1m', 180: '3m', 300: '5m', 900: '15m', 3600: '1h' };

                if (interval === currentInterval) {
                    const ivSec_m = ivToSec(interval);
                    // ROBUST FIX: Only sub-1m intervals are purely "managed" by our aggregator.
                    // For 1m+, we allow the official Binance kline stream to update the chart 
                    // for maximum historical accuracy, while Trade ticks handle the tail.
                    const isManaged = ivSec_m < 60;

                    // If NOT purely managed by our aggregator, update chart from official stream
                    if (!isManaged) {
                        // Update Main Chart
                        candleSeries.update(candle);
                        volumeSeries.update({
                            time: candle.time,
                            value: candle.volume,
                            color: candle.close >= candle.open ? '#0ecb8133' : '#f6465d33',
                        });

                        const lastCandle = candleData[candleData.length - 1];
                        if (lastCandle && lastCandle.time === candle.time) candleData[candleData.length - 1] = candle;
                        else { candleData.push(candle); if (candleData.length > 2000) candleData.shift(); }

                        candleCache[ivSec_m] = candleData.slice();

                        if (!window.lastDrawTime || Date.now() - window.lastDrawTime > 1000) {
                            drawIndicators(candleData);
                            window.lastDrawTime = Date.now();
                            handleAllStrategies();
                        }
                    }
                }

                if (interval === tfMap[hedgeTfSecs]) {
                    // Update Hedge Cache (STABLE MERGE)
                    if (!candleCache[hedgeTfSecs]) candleCache[hedgeTfSecs] = [];
                    const cache = candleCache[hedgeTfSecs];
                    const last = cache[cache.length - 1];

                    if (last) {
                        if (candle.time === last.time) {
                            cache[cache.length - 1] = candle; // update current
                        } else if (candle.time > last.time) {
                            cache.push(candle); // push new
                            if (cache.length > 500) cache.shift();
                        }
                    } else {
                        cache.push(candle);
                    }
                }
            }
            else if (msg.type === 'mark_price') {
                if (msg.symbol !== currentSymbol) return;
                const d = msg.data;
                const markEl = document.getElementById('stat-mark');
                const indexEl = document.getElementById('stat-index');
                const fundingEl = document.getElementById('stat-funding');

                if (d.markPrice) {
                    lastMarkPrice = parseFloat(d.markPrice);
                    if (markEl) markEl.textContent = formatPrice(lastMarkPrice);
                    updateMarkDiff();
                }
                if (indexEl && d.indexPrice) indexEl.textContent = formatPrice(d.indexPrice);
                if (fundingEl && d.lastFundingRate) {
                    try {
                        const fPct = (d.lastFundingRate * 100).toFixed(4) + '%';
                        const diff = Math.max(0, d.nextFundingTime - Date.now());
                        const h = Math.floor(diff / 3600000);
                        const m = Math.floor((diff % 3600000) / 60000);
                        const s = Math.floor((diff % 60000) / 1000);
                        const cd = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                        fundingEl.textContent = `${fPct} / ${cd}`;
                    } catch (e) { }
                }
            }
        } catch (err) {
            console.error('[Sync] SSE Message Processing Error:', err);
        }
    };
}

async function notifyActiveContext() {
    const hedgeTfSecs = parseInt(document.getElementById('cfg-hedge-tf')?.value || '60');
    const tfMap = { 60: '1m', 180: '3m', 300: '5m', 900: '15m', 3600: '1h' };

    // Ensure we notify backend with a valid standard interval (>=1m) 
    // even if we are currently viewing sub-minute synthetic charts.
    const activeIvSecs = ivToSec(currentInterval);
    const backendInterval = activeIvSecs < 60 ? '1m' : currentInterval;

    try {
        await fetch('/api/active-symbol', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol: currentSymbol,
                interval: backendInterval,
                hedgeInterval: tfMap[hedgeTfSecs] || '1m'
            })
        });
    } catch (e) {
        console.warn("[Sync] Context notification failed:", e);
    }
}

function handleAllStrategies() {
    const now = Date.now();
    // 500ms strict throttle for bot analysis to prevent CPU saturation
    if (now - lastBotPulseTime < 500) return;

    // Skip if price hasn't moved (prevents redundant calculations on high-freq ticks)
    if (lastPrice === lastPriceProcessedForBots) return;

    lastBotPulseTime = now;
    lastPriceProcessedForBots = lastPrice;

    handleSuperTrendBot();
    handleTripleStRsiBot();
    handlePureSuperTrendBot();
    handleVWAPMomentumBot();
    handleMACDTrendBot();
    handleBollingerMeanRevBot();
    handleStochVWAPBot();
    handleHeikinAshiBot();
    handlePureSARBot();
    handlePureRSIBot();
    handlePureEMABot();
    handlePureRsiEmaBot();
    handleStSarAdxBot();
    handleComboBot();
    handleRsiEmaPivotBot();
}

function clearAllCaches() {
    // Clear all numeric and string keys to be safe
    Object.keys(candleCache).forEach(k => { candleCache[k] = []; });
    Object.keys(openCandles).forEach(k => { openCandles[k] = null; });

    // Re-initialize with numeric keys only
    SYNTHETIC_SECS.forEach(sec => {
        candleCache[sec] = [];
        openCandles[sec] = null;
    });

    latestBinanceTimeMs = 0;
    localTimeAtBinanceTick = 0;
}

function connectPriceWs() {
    if (!isServerless) {
        console.log("[Sync] connectPriceWs is now handled by Hub");
        return;
    }
    if (priceWs) priceWs.close();
    const stream = `${currentSymbol.toLowerCase()}@aggTrade`;
    priceWs = new WebSocket(`${BINANCE_WS_MIRROR}/${stream}`);
    priceWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const price = parseFloat(msg.p);
        const qty = parseFloat(msg.q);
        const ts = msg.T;
        lastPrice = price;
        lastPriceTime = Date.now();
        updatePriceDisplay(price);
        updateRecentTradesFromWs(msg);
        feed1sTick(price, qty, ts);
    };
    priceWs.onclose = () => { if (isServerless) setTimeout(connectPriceWs, 5000); };
}

function connectTickerWs() {
    if (!isServerless) {
        console.log("[Sync] connectTickerWs is now handled by Hub");
        return;
    }
    // For direct mode, we use the !ticker@arr stream for market browser
    const tickerWs = new WebSocket(`${BINANCE_WS_MIRROR}/!ticker@arr`);
    tickerWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const prices = {};
        const tickers = {};
        msg.forEach(t => {
            prices[t.s] = parseFloat(t.c);
            tickers[t.s] = {
                price: parseFloat(t.c),
                changePercent: parseFloat(t.P),
                quoteVolume: parseFloat(t.q),
                high: parseFloat(t.h),
                low: parseFloat(t.l)
            };
        });
        lastPricesObj = prices;
        lastTickersObj = tickers;
        renderWatchlist(lastPricesObj, lastTickersObj);
    };
    tickerWs.onerror = (e) => {
        logEngine("? Market Browser WS Connection Error (is it blocked in your region?)", "error");
    };
    tickerWs.onclose = () => { if (isServerless) setTimeout(connectTickerWs, 5000); };
}

function connectMarkPriceWs() {
    if (!isServerless) return;
    // For direct mode, we use !markPrice@arr@1s for mark price, index price, funding
    const markWs = new WebSocket(`${BINANCE_WS_MIRROR}/!markPrice@arr@1s`);
    markWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        msg.forEach(d => {
            if (d.s === currentSymbol) {
                const markEl = document.getElementById('stat-mark');
                const indexEl = document.getElementById('stat-index');
                const fundingEl = document.getElementById('stat-funding');

                if (d.p) {
                    lastMarkPrice = parseFloat(d.p);
                    if (markEl) markEl.textContent = formatPrice(lastMarkPrice);
                    updateMarkDiff();
                }
                if (indexEl && d.i) indexEl.textContent = formatPrice(d.i);
                if (fundingEl && d.r) {
                    try {
                        const fPct = (parseFloat(d.r) * 100).toFixed(4) + '%';
                        const diff = Math.max(0, d.T - Date.now());
                        const h = Math.floor(diff / 3600000);
                        const m = Math.floor((diff % 3600000) / 60000);
                        const s = Math.floor((diff % 60000) / 1000);
                        const cd = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                        fundingEl.textContent = `${fPct} / ${cd}`;
                    } catch (err) { }
                }
            }
        });
    };
    markWs.onerror = (e) => { logEngine("? Mark Price WS Connection Error", "error"); };
    markWs.onclose = () => { if (isServerless) setTimeout(connectMarkPriceWs, 5000); };
}

function connectOrderbookWs() {
    if (!isServerless) {
        console.log("[Sync] connectOrderbookWs is now handled by Hub");
        return;
    }
    const obWs = new WebSocket(`${BINANCE_WS_MIRROR}/${currentSymbol.toLowerCase()}@depth10@100ms`);
    obWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        renderOrderbookFromWs(msg);
    };
    obWs.onclose = () => { if (isServerless) setTimeout(connectOrderbookWs, 5000); };
}

let _lastRtUpdate = 0;
function updateRecentTradesFromWs(trade) {
    const listEl = document.getElementById('recent-trades-list');
    if (!listEl) return;

    // Throttle UI update � Only update 2x per second max for performance
    const now = Date.now();
    if (now - _lastRtUpdate < 500) return;
    _lastRtUpdate = now;

    // Add to top of list
    const row = document.createElement('div');
    row.className = 'trade-row';
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr 1fr 1fr';
    row.style.fontSize = '10px';
    row.style.padding = '2px 6px';

    const isBuyerMaker = trade.m;
    const color = isBuyerMaker ? 'var(--down)' : 'var(--up)';

    row.innerHTML = `
        <span style="color:${color}">${parseFloat(trade.p).toFixed(2)}</span>
        <span style="text-align:right;">${parseFloat(trade.q).toFixed(3)}</span>
        <span style="text-align:right; color:var(--text-secondary);">${new Date(trade.T).toLocaleTimeString([], { hour12: false })}</span>
    `;

    listEl.prepend(row);
    if (listEl.children.length > 20) listEl.lastChild.remove();
}

let _lastObUpdate = 0;
function renderOrderbookFromWs(data) {
    const bidsEl = document.getElementById('ob-bids');
    const asksEl = document.getElementById('ob-asks');
    if (!bidsEl || !asksEl) return;

    // Throttle OB rendering for performance: 1x per second is enough for visual feedback
    const now = Date.now();
    if (now - _lastObUpdate < 1000) return;
    _lastObUpdate = now;

    const renderLevel = (price, qty, color) => `
        <div style="display:flex; justify-content:space-between; padding:2px 8px; font-size:10px; position:relative;">
            <span style="color:${color}; z-index:1;">${parseFloat(price).toFixed(2)}</span>
            <span style="z-index:1;">${parseFloat(qty).toFixed(3)}</span>
        </div>
    `;

    // Bids (descending price)
    bidsEl.innerHTML = data.b.slice(0, 8).map(l => renderLevel(l[0], l[1], 'var(--up)')).join('');
    // Asks (ascending price)
    asksEl.innerHTML = data.a.slice(0, 8).reverse().map(l => renderLevel(l[0], l[1], 'var(--down)')).join('');
}

function connectKlineWs() {
    if (!isServerless) {
        // Ensure background tick timer is always running for synthetic history buildup
        if (!synthetic1sTimer) start1sBuilder();
        // Notify backend about active context
        notifyActiveContext();
        // Ensure Hub is connected
        if (!centralStream) initCentralStream();
        return;
    }

    // Direct Binance Kline Stream
    if (klineWs) klineWs.close();
    const stream = `${currentSymbol.toLowerCase()}@kline_${currentInterval}`;
    klineWs = new WebSocket(`${BINANCE_WS_MIRROR}/${stream}`);
    klineWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const k = msg.k;
        const candle = {
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v)
        };
        // Update Chart
        candleSeries.update(candle);
        const lastCandle = candleData[candleData.length - 1];
        if (lastCandle && lastCandle.time === candle.time) candleData[candleData.length - 1] = candle;
        else { candleData.push(candle); if (candleData.length > 2000) candleData.shift(); }

        if (!window.lastDrawTime || Date.now() - window.lastDrawTime > 1000) {
            drawIndicators(candleData);
            window.lastDrawTime = Date.now();
            handleAllStrategies();
        }
    };
    klineWs.onclose = () => { if (isServerless) setTimeout(connectKlineWs, 5000); };

    // Also start builder for synthetic intervals
    if (!synthetic1sTimer) start1sBuilder();
}

// ---- Background Hedge TF Kline WebSocket ----
// Keeps candleCache[hedgeTfSecs] LIVE with real-time closed candles
// so evaluateSmartHedge always evaluates against current data, not stale REST snapshots.
let hedgeKlineWs = null;

function connectHedgeKlineWs() {
    if (!isServerless) {
        // Deprecated: Hub handles kline streams for both main and hedge TFs
        console.log("[Sync] connectHedgeKlineWs is now handled by Hub");
        return;
    }
    const hedgeTfSecs = parseInt(document.getElementById('cfg-hedge-tf')?.value || '60');
    const tfMap = { 60: '1m', 180: '3m', 300: '5m', 900: '15m', 3600: '1h' };
    const interval = tfMap[hedgeTfSecs] || '1m';

    const hWs = new WebSocket(`${BINANCE_WS_MIRROR}/${currentSymbol.toLowerCase()}@kline_${interval}`);
    hWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const k = msg.k;
        const candle = {
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v)
        };
        if (!candleCache[hedgeTfSecs]) candleCache[hedgeTfSecs] = [];
        const cache = candleCache[hedgeTfSecs];
        const last = cache[cache.length - 1];
        if (last && last.time === candle.time) cache[cache.length - 1] = candle;
        else { cache.push(candle); if (cache.length > 500) cache.shift(); }
    };
    hWs.onclose = () => { if (isServerless) setTimeout(connectHedgeKlineWs, 5000); };
}

async function setBinanceLeverage(lev) {
    try {
        await fetch('/api/futures/leverage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: currentSymbol, leverage: lev })
        });
    } catch (e) { console.error(e); }
}

// ============================================================
// BOT ENGINE & RISK MANAGEMENT
// ============================================================
let lastLogMsg = '';
let lastLogTime = 0;

// Performance Throttling State
let lastPriceProcessedForIndicators = 0;
let lastPriceProcessedForBots = 0;
let lastIndicatorDrawTime = 0;
let lastBotPulseTime = 0;

function logEngine(msg, type = 'info') {
    const logEl = document.getElementById('engine-log');
    if (!logEl) return;

    // Throttle identical repetitive logs to prevent DOM repaint lag 
    // (max 1 identical log every 3 seconds, except for critical error/success events)
    const now = Date.now();
    if (msg === lastLogMsg && (now - lastLogTime) < 3000) {
        return;
    }
    lastLogMsg = msg;
    lastLogTime = now;

    const item = document.createElement('div');
    item.className = `log-item ${type}`;
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    item.innerHTML = `<span class="log-time">${time}</span>${msg}`;

    // Use requestAnimationFrame or just append if batching isn't needed
    logEl.appendChild(item);
    logEl.scrollTop = logEl.scrollHeight;

    // Aggressive DOM cleanup: keep last 200 log entries max
    while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
}

function clearEngineLog() {
    const logEl = document.getElementById('engine-log');
    if (logEl) logEl.innerHTML = '';
}

function calculateLiquidationPrice(entry, lev, side) {
    if (lev <= 1) return 0;
    const maintenanceMargin = 0.004;
    if (side === 'BUY' || side === 'LONG') {
        return entry * (1 - (1 / lev) + maintenanceMargin);
    } else {
        return entry * (1 + (1 / lev) - maintenanceMargin);
    }
}

let stBotHedgePosition = null;

// ============================================================
// SUPERTREND SCALPING BOT
// ============================================================
function stBotOpenPosition(side, entryPrice, stLineValue, isHedge = false) {
    // ? PROMOTION INTERCEPTOR: If opening a main trade and a hedge already exists in this direction
    if (!isHedge && stBotHedgePosition && stBotHedgePosition.side === side) {
        const oldId = stBotHedgePosition.id;
        stBotPosition = stBotHedgePosition;
        stBotPosition.isHedge = false; // Now main
        stBotPosition.id = Date.now() + "_PROMOTED";

        // Sync ID with the paperPositions UI ledger to prevent phantom cards
        const cardIdx = paperPositions.findIndex(p => p.id === oldId);
        if (cardIdx !== -1) paperPositions[cardIdx].id = stBotPosition.id;

        stBotPosition.reason = "Promoted to Main";
        stBotHedgePosition = null;
        updatePriceDisplay(entryPrice); // Ensure UI refresh of main position state
        return true;
    }

    // Safety checks: do not open duplicates!
    if (isHedge && stBotHedgePosition) {
        logEngine(`⚠️ Prevented duplicate HEDGE position.`, 'error');
        return false;
    }
    if (!isHedge && stBotPosition) {
        logEngine(`⚠️ Prevented duplicate MAIN position.`, 'error');
        return false;
    }

    const betSize = parseFloat(document.getElementById('cfg-bet-size')?.value || '10');
    const engLeverage = parseInt(document.getElementById('cfg-engine-leverage')?.value || '10');
    const notional = betSize * engLeverage;
    const marginRequired = betSize; // margin = betSize, notional = betSize * leverage
    const quantity = notional / entryPrice;

    const newPos = {
        id: Date.now() + (isHedge ? "_HEDGE" : ""),
        side: side, // 'LONG' or 'SHORT'
        entryPrice: entryPrice,
        quantity: quantity,
        margin: marginRequired,
        notional: notional,
        leverage: engLeverage,
        trailingSL: stLineValue,
        stLine: stLineValue,
        symbol: currentSymbol,
        openedAt: new Date().toLocaleTimeString([], { hour12: false }),
        highestPrice: entryPrice,
        lowestPrice: entryPrice,
        isHedge: isHedge,
        hasTakenPartialTP: false, // Track partial TP state
        reason: isHedge ? "Hedge Start" : "Indicator Signal"
    };

    if (isHedge) {
        stBotHedgePosition = newPos;
    } else {
        stBotPosition = newPos;
    }

    // Track Bot Positions in the Ledger UI (Both SIM and REAL)
    if (engineTradeMode === 'sim') {
        if (paperBalance < marginRequired) {
            logEngine(`❌ Insufficient paper balance ($${paperBalance.toFixed(2)}) for margin ($${marginRequired.toFixed(2)})`, 'error');
            if (isHedge) stBotHedgePosition = null;
            else stBotPosition = null;
            return false;
        }
        paperBalance -= marginRequired;
    }

    // Push the position to the ledger so the user can track the active trade metrics in the UI
    paperPositions.push({
        id: newPos.id,
        symbol: currentSymbol,
        side: side,
        entryPrice: entryPrice,
        amount: notional,
        margin: marginRequired,
        leverage: engLeverage,
        qty: quantity,
        time: new Date(),
        timeframe: isHedge ? (document.getElementById('cfg-hedge-tf')?.selectedOptions?.[0]?.text || 'Hedge') : (document.getElementById('trade-timeframe')?.value || tradeInterval),
        source: engineTradeMode === 'sim' ? 'SIM_BOT' : 'REAL_BOT'
    });
    renderPaperPositions();

    stBotTradeCount++;
    return true;
}

function stBotClosePosition(exitPrice, reason, isHedge = false, pct = 1.0) {
    const pos = isHedge ? stBotHedgePosition : stBotPosition;
    if (!pos) return;

    const isPartial = pct < 1.0;
    const closedQty = pos.quantity * pct;
    const closedNotional = pos.notional * pct;

    const isLong = pos.side === 'LONG';
    const diff = isLong ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const pnl = (closedNotional / pos.entryPrice) * diff;
    const pnlPct = (diff / pos.entryPrice) * 100;
    const sign = pnl >= 0 ? '+' : '';

    // TRACK COUNTERPART (for history sync)
    let counterpartPnlObj = null;
    const counterpart = isHedge ? stBotPosition : stBotHedgePosition;
    if (counterpart) {
        const c_diff = counterpart.side === 'LONG' ? exitPrice - counterpart.entryPrice : counterpart.entryPrice - exitPrice;
        const c_pnl = (counterpart.notional / counterpart.entryPrice) * c_diff;
        const c_pnlPct = (c_diff / counterpart.entryPrice) * 100;
        counterpartPnlObj = { pnl: c_pnl, pnlPct: c_pnlPct, side: counterpart.side };
    }

    if (isPartial) {
        // Realize partial profit but keep live position object alive with reduced metrics
        pos.quantity -= closedQty;
        pos.notional -= closedNotional;
        pos.margin -= (pos.margin * pct);
        logEngine(`?? PARTIAL ${pct * 100}% TP realized: ${sign}$${pnl.toFixed(2)} | Remaining: ${pos.quantity.toFixed(3)}`, 'success');
    } else {
        // Full close logic
        if (isHedge) {
            stBotHedgePosition = null;
        } else {
            stBotPosition = null;
            // ? HEDGE PROMOTION: If main position is closed, and a hedge exists, promote it!
            if (stBotHedgePosition) {
                logEngine(`🛡️ HEDGE PROMOTED: Main position closed. Hedge ${stBotHedgePosition.side} is now the Main position.`, 'success');
                const oldId = stBotHedgePosition.id;
                stBotPosition = stBotHedgePosition;
                stBotPosition.isHedge = false;
                stBotPosition.id = Date.now() + "_PROMOTED";

                // Sync ID with the paperPositions UI ledger to prevent phantom cards
                const cardIdx = paperPositions.findIndex(p => p.id === oldId);
                if (cardIdx !== -1) paperPositions[cardIdx].id = stBotPosition.id;

                stBotHedgePosition = null;
                updatePriceDisplay(exitPrice);
            }
        }
        stBotTradeCount++;
    }

    // If Main closes while Hedge is alive (which means Hedge is about to be Promoted!)
    // Pass the dying Main's PnL to the Hedge so it can remember its origins.
    if (!isHedge && stBotHedgePosition) {
        stBotHedgePosition.inheritedMainPnlObj = { pnl: pnl, pnlPct: pnlPct };
    }

    // Sync Bot Position in the unified UI ledger
    const idx = paperPositions.findIndex(p => p.id === pos.id);
    if (idx !== -1) {
        if (engineTradeMode === 'sim') {
            paperBalance += (pos.margin * pct) + pnl; // Note: margin used was proportional
        }

        const historyEntry = {
            id: pos.id + (isPartial ? "_" + Date.now() : ""),
            symbol: pos.symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: exitPrice,
            amount: closedNotional,
            margin: pos.margin * pct,
            leverage: pos.leverage,
            pnl: pnl,
            pnlPct: pnlPct,
            closedAt: new Date().toLocaleTimeString([], { hour12: false }),
            reason: reason,
            source: engineTradeMode === 'sim' ? 'SIM_BOT' : 'REAL_BOT',
            isHedge: isHedge,
            counterpartState: counterpartPnlObj,
            inheritedMainState: pos.inheritedMainPnlObj || null
        };
        paperTradeHistory.unshift(historyEntry);
        if (paperTradeHistory.length > 50) paperTradeHistory.pop();

        if (isPartial) {
            // Update the live position in the ledger instead of removing
            paperPositions[idx].amount = pos.notional;
            paperPositions[idx].qty = pos.quantity;
            paperPositions[idx].margin = pos.margin;
        } else {
            paperPositions.splice(idx, 1);
        }
        renderPaperPositions();
    }

    const finalSL = pos.trailingSL || pos.atrSL || 0;
    logEngine(`${pnl >= 0 ? '??' : '??'} CLOSED ${isPartial ? 'PARTIAL' : 'FULL'} ${pos.side}${isHedge ? ' (HEDGE)' : ''} | Reason: ${reason} | Entry: ${formatPrice(pos.entryPrice)} → Exit: ${formatPrice(exitPrice)} | PnL: ${sign}$${Math.abs(pnl).toFixed(2)} (${sign}${pnlPct.toFixed(2)}%) | ${pos.leverage}x | Trail SL was: ${formatPrice(finalSL)}`, pnl >= 0 ? 'success' : 'error');
    showToast(`${pnl >= 0 ? '?' : '?'} ST Bot ${isHedge ? 'Hedge ' : ''}${reason}: ${sign}$${Math.abs(pnl).toFixed(2)}`, pnl >= 0 ? 'success' : 'error');

    if (!isPartial && !isHedge) {
        // Update UI only if main position closes fully
        if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = '? Waiting for next signal...';
        document.getElementById('engine-trailing-sl').textContent = '--';
    }
}

async function stBotCloseReal(reason, isHedge = false, pct = 1.0) {
    const pos = isHedge ? stBotHedgePosition : stBotPosition;
    if (!pos) return;
    const isPartial = pct < 1.0;
    try {
        const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
        const rawQty = pos.quantity * pct;
        const qty = await safeQuantity(currentSymbol, rawQty);
        logEngine(`⚡ Closing REAL ${isPartial ? (pct * 100) + '%' : 'FULL'} ${pos.side}${isHedge ? ' (HEDGE)' : ''} position (${reason})...`, 'warning');

        const reqBody = {
            symbol: currentSymbol,
            side: closeSide,
            quantity: qty,
            type: 'MARKET'
        };
        if (isHedgeMode) reqBody.positionSide = pos.side;

        const r = await fetch('/api/futures/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody)
        });

        const result = await r.json();
        if (result.orderId) {
            stBotClosePosition(lastPrice, reason, isHedge, pct);
            fetchOpenOrders();
        } else {
            throw new Error(result.msg || result.error || JSON.stringify(result));
        }
    } catch (e) {
        if (e.message && (e.message.includes('ReduceOnly') || e.message.includes('reduce position below zero') || e.message.includes('available balance'))) {
            logEngine(`?? Exchange says position is already closed (${e.message}). Reconciling local state...`, 'warning');
            stBotClosePosition(lastPrice, `${reason} (Force Sync)`, isHedge);
        } else {
            logEngine(`? REAL close failed: ${e.message}`, 'error');
        }
    }
}

async function stBotOpenReal(side, isHedge = false) {
    try {
        if (!isHedge && stBotHedgePosition && stBotHedgePosition.side === side) {
            logEngine(`?? HEDGE PROMOTED TO MAIN: ${side} position already active from Hedge Mode`, 'success');
            return true;
        }

        const engLeverage = parseInt(document.getElementById('cfg-engine-leverage')?.value || '10');
        const betSize = parseFloat(document.getElementById('cfg-bet-size')?.value || '10');
        const notional = betSize * engLeverage;
        const rawQty = notional / lastPrice;
        const qty = await safeQuantity(currentSymbol, rawQty);
        const binanceSide = side === 'LONG' ? 'BUY' : 'SELL';

        if (parseFloat(qty) <= 0) {
            logEngine(`?? Calculated qty is 0 after precision rounding. Increase bet size or leverage.`, 'error');
            return false;
        }

        await setBinanceLeverage(engLeverage);
        logEngine(`⚡ Opening REAL ${side}${isHedge ? ' (HEDGE)' : ''} | Qty: ${qty} | Notional: $${notional.toFixed(2)} | Lev: ${engLeverage}x`, 'warning');

        const reqBody = {
            symbol: currentSymbol,
            side: binanceSide,
            quantity: qty,
            type: 'MARKET'
        };
        if (isHedgeMode) reqBody.positionSide = side;

        const r = await fetch('/api/futures/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody)
        });
        const result = await r.json();
        if (result.orderId) {
            logEngine(`? REAL ${side}${isHedge ? ' (HEDGE)' : ''} order filled: ${result.orderId}`, 'success');
        } else {
            logEngine(`? REAL order failed: ${result.msg || JSON.stringify(result)}`, 'error');
            return false;
        }
        fetchOpenOrders();
        return true;
    } catch (e) {
        logEngine(`? REAL order error: ${e.message}`, 'error');
        return false;
    }
}

async function evaluateSmartHedge(price) {
    const enableHedge = document.getElementById('cfg-smart-hedge')?.checked;
    if (!enableHedge) return;

    // Find active Bot position - ONLY hedge for bot-managed trades
    const pos = stBotPosition;
    if (!pos) return;

    // Throttle: only re-evaluate once per second max
    const now = Date.now();
    if (window.lastHedgeEval && now - window.lastHedgeEval < 1000) return;
    window.lastHedgeEval = now;

    // Log to thinking panel every 5 seconds
    const shouldLogNow = !window.lastHedgeLog || now - window.lastHedgeLog > 5000;
    if (shouldLogNow) window.lastHedgeLog = now;

    const engineMode = document.getElementById('engine-mode')?.value;
    const hedgeTfSecs = parseInt(document.getElementById('cfg-hedge-tf')?.value || '60');

    // Compare with Trade Timeframe instead of Chart Timeframe
    let currentActiveSecs = tradeIntervalSecs;

    // Relax check: Hedge TF can be any timeframe the user wants, but warn if it's much larger than chart
    if (hedgeTfSecs > currentActiveSecs * 10) {
        if (shouldLogNow) logEngine(`🛡️ HEDGE: Warning :� Hedge TF (${hedgeTfSecs}s) is significantly LARGER than Chart TF (${currentActiveSecs}s). Reversals might be detected late.`, 'warning');
    }

    // Verify we have enough historical data for the indicator
    const cache = candleCache[hedgeTfSecs];
    const cacheLen = cache ? cache.length : 0;
    // SAR/Indicators need enough history to converge reliably to chart values
    if (!cache || cacheLen < 200) {
        if (shouldLogNow) logEngine(`🛡️ HEDGE: Cache building... (${cacheLen} / 200 candles on ${hedgeTfSecs}s TF).`, 'warning');
        fetchBackgroundHedgeKlines();
        return;
    }

    // -- LIVE CANDLE MERGE: Ensure we include the absolute latest movement --
    let effectiveKlines = [...cache];
    const oc = openCandles[hedgeTfSecs];
    if (oc && oc.time > (effectiveKlines[effectiveKlines.length - 1]?.time || 0)) {
        effectiveKlines.push(oc);
    }

    // -- Compute Indicator on Lower TF --
    let hedgeSignal = null;
    let indicatorValue = '';

    const hedgeTfLabel = document.getElementById('cfg-hedge-tf')?.selectedOptions?.[0]?.text || `${hedgeTfSecs}s`;
    // We now always include the live candle, so evalIdx is consistently -1 (latest)
    const evalIdx = -1;

    try {
        if (engineMode === 'pure_sar') {
            const afStart = parseLocaleFloat(document.getElementById('cfg-sar-af-start')?.value, 0.02);
            const afStep = parseLocaleFloat(document.getElementById('cfg-sar-af-step')?.value, 0.02);
            const afMax = parseLocaleFloat(document.getElementById('cfg-sar-af-max')?.value, 0.2);
            const psar = calcParabolicSAR(effectiveKlines, afStart, afStep, afMax);

            const currDir = psar.direction[psar.direction.length + evalIdx];
            const currSarVal = psar.sar[psar.sar.length + evalIdx];
            if (currDir === 0 || currSarVal === null) {
                if (shouldLogNow) logEngine(`🛡️ HEDGE: SAR not yet initialized on ${hedgeTfLabel} cache`, 'warning');
                return;
            }
            hedgeSignal = currDir === 1 ? 'LONG' : 'SHORT';
            indicatorValue = `${hedgeTfLabel} SAR=${formatPrice(currSarVal)} ? Trend=${hedgeSignal}`;

        } else if (engineMode === 'pure_supertrend') {
            const stP = parseInt(document.getElementById('cfg-st-period')?.value || '10');
            const stM = parseFloat(document.getElementById('cfg-st-multiplier')?.value || '3');
            const st = calcSupertrendRaw(effectiveKlines, stP, stM);
            const currDir = st.direction[st.direction.length + evalIdx];
            const currStVal = st.stValue[st.stValue.length + evalIdx];
            hedgeSignal = currDir === 1 ? 'LONG' : 'SHORT';
            indicatorValue = `${hedgeTfLabel} ST=${formatPrice(currStVal)} ? Trend=${hedgeSignal}`;

        } else if (engineMode === 'pure_rsi') {
            const p = parseInt(document.getElementById('cfg-prsi-period')?.value || '14');
            const ob = parseInt(document.getElementById('cfg-prsi-ob')?.value || '70');
            const os = parseInt(document.getElementById('cfg-prsi-os')?.value || '30');
            const rsiArr = calcRSI(effectiveKlines.map(c => c.close), p);
            const currRsi = rsiArr[rsiArr.length + evalIdx];
            indicatorValue = `${hedgeTfLabel} RSI=${currRsi.toFixed(1)} (OB:${ob}/OS:${os})`;
            if (currRsi > ob) hedgeSignal = 'SHORT';
            else if (currRsi < os) hedgeSignal = 'LONG';
            else {
                if (shouldLogNow) logEngine(`🛡️ HEDGE: ${indicatorValue} ? NEUTRAL, no hedge`, 'info');
                return;
            }

        } else if (engineMode === 'pure_ema') {
            const fp = parseInt(document.getElementById('cfg-pema-fast')?.value || '9');
            const sp = parseInt(document.getElementById('cfg-pema-slow')?.value || '21');
            const closes = effectiveKlines.map(c => c.close);
            const fEma = calcEMA(closes, fp);
            const sEma = calcEMA(closes, sp);
            const currF = fEma[fEma.length + evalIdx];
            const currS = sEma[sEma.length + evalIdx];
            hedgeSignal = currF > currS ? 'LONG' : 'SHORT';
            indicatorValue = `${hedgeTfLabel} FastEMA=${formatPrice(currF)} SlowEMA=${formatPrice(currS)} ? Trend=${hedgeSignal}`;

        } else if (engineMode === 'pure_rsi_ema') {
            const fp = parseInt(document.getElementById('cfg-pre-fast')?.value || '9');
            const sp = parseInt(document.getElementById('cfg-pre-slow')?.value || '21');
            const closes = effectiveKlines.map(c => c.close);
            const fEma = calcEMA(closes, fp);
            const sEma = calcEMA(closes, sp);
            const rsiArr = calcRSI(closes, parseInt(document.getElementById('cfg-pre-rsi-period')?.value || '14'));

            const currF = fEma[fEma.length + evalIdx];
            const currS = sEma[sEma.length + evalIdx];
            const currRsi = rsiArr[rsiArr.length + evalIdx];

            const isBullish = currF > currS;
            indicatorValue = `${hedgeTfLabel} RSI=${currRsi.toFixed(1)} EMA=${isBullish ? 'BULL' : 'BEAR'}`;
            if (isBullish && currRsi < 70) hedgeSignal = 'LONG';
            else if (!isBullish && currRsi > 30) hedgeSignal = 'SHORT';
            else {
                if (shouldLogNow) logEngine(`🛡️ HEDGE: ${indicatorValue} ? NEUTRAL`, 'info');
                return;
            }
        } else if (engineMode === 'rsi_ema_pivot') {
            const closes = effectiveKlines.map(c => c.close);
            const ema20Arr = calcEMA(closes, 20);
            const ema50Arr = calcEMA(closes, 50);
            const rsiArr = calcRSI(closes, 14);
            const currE20 = ema20Arr[ema20Arr.length + evalIdx];
            const currE50 = ema50Arr[ema50Arr.length + evalIdx];
            const currRsi = rsiArr[rsiArr.length + evalIdx];
            const currClose = effectiveKlines[effectiveKlines.length - 1].close;

            // --- ROLLING PIVOT CALC (Matching Main Bot) ---
            const lookbackMap = { '1m': 1440, '2m': 720, '3m': 480, '5m': 288, '15m': 96, '1h': 24 };
            const lb = lookbackMap[hedgeTfLabel] || 24;
            const startIdx = Math.max(0, effectiveKlines.length - 1 - lb);
            const rangeKlines = effectiveKlines.slice(startIdx);
            const pHigh = Math.max(...rangeKlines.map(k => k.high));
            const pLow = Math.min(...rangeKlines.map(k => k.low));
            const P = (pHigh + pLow + currClose) / 3;

            const rsi_up = currRsi >= 50;
            const price_up = currClose >= P;
            const trend_bullish = currE20 > currE50;
            const trend_bearish = currE20 < currE50;

            // NEW SENSITIVE LOGIC (Matches Main Bot)
            if (price_up && rsi_up) hedgeSignal = 'LONG';
            else if (!price_up && !rsi_up) hedgeSignal = 'SHORT';
            else if (trend_bullish) hedgeSignal = 'LONG';
            else if (trend_bearish) hedgeSignal = 'SHORT';
            else hedgeSignal = price_up ? 'LONG' : 'SHORT';

            indicatorValue = `${hedgeTfLabel} RSI=${currRsi.toFixed(1)} EMA=${trend_bullish ? 'UP' : 'DN'} PIVOT=${price_up ? 'ABOVE' : 'BELOW'}`;

            if (!hedgeSignal) {
                if (shouldLogNow) logEngine(`🛡️ HEDGE: ${indicatorValue} ? NEUTRAL`, 'info');
                return;
            }
        } else if (engineMode === 'vwap_momentum') {
            const period = parseInt(document.getElementById('cfg-vwap-mom-period')?.value || '20');
            const vwapArr = calcVWAP(effectiveKlines);
            const priceArr = effectiveKlines.map(c => c.close);
            const currPrice = priceArr[priceArr.length + evalIdx];
            const currVWAP = vwapArr[vwapArr.length + evalIdx];
            hedgeSignal = currPrice > currVWAP ? 'LONG' : 'SHORT';
            indicatorValue = `${hedgeTfLabel} VWAP=${formatPrice(currVWAP)} ? Trend=${hedgeSignal}`;

        } else if (engineMode === 'st_sar_adx') {
            const stPeriod = parseInt(document.getElementById('cfg-st-period')?.value || '10');
            const stMult = parseLocaleFloat(document.getElementById('cfg-st-multiplier')?.value, 3);
            const afStart = parseLocaleFloat(document.getElementById('cfg-st-sar-af-start')?.value, 0.02);
            const afStep = parseLocaleFloat(document.getElementById('cfg-st-sar-af-step')?.value, 0.02);
            const afMax = parseLocaleFloat(document.getElementById('cfg-st-sar-af-max')?.value, 0.2);

            const psar = calcParabolicSAR(effectiveKlines, afStart, afStep, afMax);
            const stResult = calcSupertrendRaw(effectiveKlines, stPeriod, stMult);
            const currSarDir = psar.direction[psar.direction.length + evalIdx];
            const currStDir = stResult.direction[stResult.direction.length + evalIdx];

            hedgeSignal = (currStDir === 1 && currSarDir === 1) ? 'LONG' : (currStDir === -1 && currSarDir === -1 ? 'SHORT' : (currStDir === 1 ? 'LONG' : 'SHORT'));
            indicatorValue = `${hedgeTfLabel} ST-SAR ? Trend=${hedgeSignal}`;

        } else if (engineMode === 'bollinger_mr') {
            const p = parseInt(document.getElementById('cfg-bb-period')?.value || '20');
            const m = parseFloat(document.getElementById('cfg-bb-mult')?.value || '2');
            const bb = calcBollingerBands(effectiveKlines.map(c => c.close), p, m);
            const currPrice = effectiveKlines[effectiveKlines.length + evalIdx].close;
            const currUpper = bb.upper[bb.upper.length + evalIdx];
            const currLower = bb.lower[bb.lower.length + evalIdx];
            // Mean reversion hedge: if price is above upper, trend is UP; below lower, trend is DN.
            hedgeSignal = currPrice > currUpper ? 'LONG' : (currPrice < currLower ? 'SHORT' : (currPrice > (currUpper + currLower) / 2 ? 'LONG' : 'SHORT'));
            indicatorValue = `${hedgeTfLabel} BB-Trend ? ${hedgeSignal}`;

        } else if (engineMode === 'stoch_vwap') {
            const rsiP = parseInt(document.getElementById('cfg-stoch-rsi')?.value || '14');
            const stochP = parseInt(document.getElementById('cfg-stoch-period')?.value || '14');
            const closes = effectiveKlines.map(c => c.close);
            const rsi = calcRSI(closes, rsiP);
            const stoch = calcStochastic(rsi, stochP, 3, 3);
            const vwap = calcVWAP(effectiveKlines);
            const currK = stoch.k[stoch.k.length + evalIdx];
            const currD = stoch.d[stoch.d.length + evalIdx];
            const currVWAP = vwap[vwap.length + evalIdx];
            const currPrice = closes[closes.length + evalIdx];
            hedgeSignal = (currK > currD && currPrice > currVWAP) ? 'LONG' : 'SHORT';
            indicatorValue = `${hedgeTfLabel} Stoch-VWAP ? ${hedgeSignal}`;

        } else if (engineMode === 'heikin_ashi') {
            const haLines = calcHeikinAshi(effectiveKlines);
            const latestHa = haLines[haLines.length + evalIdx];
            hedgeSignal = latestHa.close > latestHa.open ? 'LONG' : 'SHORT';
            indicatorValue = `${hedgeTfLabel} Heikin-Ashi ? ${hedgeSignal}`;

        } else if (engineMode === 'macd_trend') {
            const fast = parseInt(document.getElementById('cfg-macd-fast')?.value || '12');
            const slow = parseInt(document.getElementById('cfg-macd-slow')?.value || '26');
            const signal = parseInt(document.getElementById('cfg-macd-signal')?.value || '9');
            const macd = calcMACD(effectiveKlines.map(c => c.close), fast, slow, signal);
            const currHist = macd.histogram[macd.histogram.length + evalIdx];
            hedgeSignal = currHist > 0 ? 'LONG' : 'SHORT';
            indicatorValue = `${hedgeTfLabel} MACD-Hist ? ${hedgeSignal}`;

        } else if (engineMode === 'triple_st_rsi') {
            const p1 = 10, p2 = 11, p3 = 12;
            const m1 = 1, m2 = 2, m3 = 3;
            const st1 = calcSupertrendRaw(effectiveKlines, p1, m1);
            const st2 = calcSupertrendRaw(effectiveKlines, p2, m2);
            const st3 = calcSupertrendRaw(effectiveKlines, p3, m3);
            const d1 = st1.direction[st1.direction.length + evalIdx];
            const d2 = st2.direction[st2.direction.length + evalIdx];
            const d3 = st3.direction[st3.direction.length + evalIdx];
            // Majority vote for hedge
            const score = d1 + d2 + d3;
            hedgeSignal = score > 0 ? 'LONG' : 'SHORT';
            indicatorValue = `${hedgeTfLabel} Triple-ST ? ${hedgeSignal}`;

        } else if (engineMode === 'combo_bot' || engineMode === 'supertrend_scalp') {
            // Use standard SuperTrend for these complex/fast strategies as a safe hedge
            const stP = 10, stM = 3;
            const st = calcSupertrendRaw(effectiveKlines, stP, stM);
            const currDir = st.direction[st.direction.length + evalIdx];
            hedgeSignal = currDir === 1 ? 'LONG' : 'SHORT';
            indicatorValue = `${hedgeTfLabel} ST-Hedge ? ${hedgeSignal}`;


        } else {
            if (shouldLogNow) logEngine(`🛡️ HEDGE: Strategy "${engineMode}" has no hedge mapping`, 'warning');
            return;
        }
    } catch (err) {
        // NEVER silently swallow errors � always surface them
        logEngine(`🛡️ HEDGE ERROR: ${err.message}`, 'error');
        console.error('[Hedge] indicator error:', err);
        return;
    }

    if (!hedgeSignal) return;

    // Update HUD signal element
    const hedgeEl = document.getElementById('engine-hedge-signal');

    // -- Case 1: Hedge already exists --
    if (stBotHedgePosition) {
        if (hedgeEl) { hedgeEl.style.display = 'inline'; hedgeEl.textContent = `| ?? HEDGE ${stBotHedgePosition.side}`; }

        // Always show decision context in the log
        if (shouldLogNow) {
            const activeIv = tradeInterval ? tradeInterval.toUpperCase() : '??';
            const chartTfLabel = activeIv;

            const hedgePnl = stBotHedgePosition.entryPrice
                ? ((stBotHedgePosition.side === 'LONG' ? price - stBotHedgePosition.entryPrice : stBotHedgePosition.entryPrice - price)
                    / stBotHedgePosition.entryPrice * 100 * (stBotHedgePosition.leverage || 10)).toFixed(2)
                : '?';
            const mainPnl = stBotPosition.entryPrice
                ? ((stBotPosition.side === 'LONG' ? price - stBotPosition.entryPrice : stBotPosition.entryPrice - price)
                    / stBotPosition.entryPrice * 100 * (stBotPosition.leverage || 10)).toFixed(2)
                : '?';

            // Calculate countdown to next main-TF candle close
            let countdownStr = '';
            try {
                const tradeCache = candleCache[tradeIntervalSecs] || [];
                const lastCandle = tradeCache[tradeCache.length - 1];
                if (lastCandle && lastCandle.time) {
                    const nowSec = Math.floor(Date.now() / 1000);
                    const candleOpenSec = lastCandle.time;
                    const candleEndSec = candleOpenSec + tradeIntervalSecs;
                    const secsLeft = Math.max(0, candleEndSec - nowSec);
                    const mm = Math.floor(secsLeft / 60);
                    const ss = secsLeft % 60;
                    countdownStr = ` | ? Trade ${chartTfLabel} candle closes in ${mm > 0 ? mm + 'm ' : ''}${ss}s`;
                }
            } catch (_) { }

            const hedgePnlVal = parseFloat(hedgePnl); // Numerical PnL %

            logEngine(
                `🛡️ HEDGE ACTIVE [${hedgeTfLabel}?${chartTfLabel}]: Main ${pos.side} (${mainPnl}%) | Hedge ${stBotHedgePosition.side} (${hedgePnl}%) | ${indicatorValue}` +
                countdownStr +
                ` | Waiting for ${hedgeTfLabel} ${engineMode.replace('pure_', '').toUpperCase()} to flip back to ${pos.side} ? hedge auto-closes`,
                'info'
            );

            // --- PARTIAL TAKE PROFIT CHECK (Hedge) ---
            if (!isNaN(hedgePnlVal) && hedgePnlVal >= 1.5 && !stBotHedgePosition.hasTakenPartialTP && !isStBotBusy) {
                stBotHedgePosition.hasTakenPartialTP = true; // Mark BEFORE async call to prevent double fire
                logEngine(`🛡️ HEDGE PARTIAL TP (50%) � Securing profit at +${hedgePnl}%!`, 'success');
                if (engineTradeMode === 'real') {
                    // Start partial close async
                    stBotCloseReal('Hedge Partial TP (1.5%)', true, 0.5).catch(e => {
                        logEngine(`? Hedge Partial TP failed: ${e.message}`, 'error');
                        stBotHedgePosition.hasTakenPartialTP = false; // Reset on failure
                    });
                } else {
                    stBotClosePosition(price, 'Hedge Partial TP (1.5%)', true, 0.5);
                }
            }
        }

        // Kill hedge if lower TF reverted back to our main direction
        if (hedgeSignal === pos.side && !isStBotBusy) {
            isStBotBusy = true;
            try {
                const hedgeTfLabel = document.getElementById('cfg-hedge-tf')?.selectedOptions?.[0]?.text || `${hedgeTfSecs}s`;
                logEngine(`🛡️ HEDGE CLOSED: ${hedgeTfLabel} ${engineMode.replace('pure_', '').toUpperCase()} flipped back to ${hedgeSignal} (aligns with main ${pos.side}). Closing hedge, restoring full exposure on main position.`, 'success');
                if (engineTradeMode === 'real') await stBotCloseReal('Hedge Reversal', true);
                else stBotClosePosition(price, 'Hedge Reversal', true);
            } finally { setTimeout(() => isStBotBusy = false, 1000); }
        }
        return;
    } else {
        if (hedgeEl) hedgeEl.style.display = 'none';
    }

    // -- Case 2: Lower TF agrees with main position ? no hedge needed --
    if (hedgeSignal === pos.side) {
        if (shouldLogNow) {
            const hedgeTfLabel = document.getElementById('cfg-hedge-tf')?.selectedOptions?.[0]?.text || `${hedgeTfSecs}s`;
            const activeIv = tradeInterval ? tradeInterval.toUpperCase() : '??';
            logEngine(`?🛡️ HEDGE SCAN [${hedgeTfLabel}?${activeIv}]: Main=${pos.side} | ${hedgeTfLabel} also=${hedgeSignal} ? Safe, aligned. ${indicatorValue} | Watching for reversal...`, 'info');
        }
        return;
    }

    // -- Case 3: Lower TF OPPOSES main position ? TRIGGER HEDGE --
    if (!isStBotBusy) {
        isStBotBusy = true;
        try {
            logEngine(`🛡️ HEDGE TRIGGER! Main=${pos.side} but Lower TF=${hedgeSignal}! | ${indicatorValue} | Opening ${hedgeSignal} hedge NOW...`, 'warning');
            if (engineTradeMode === 'real') {
                const ok = await stBotOpenReal(hedgeSignal, true);
                if (ok) stBotOpenPosition(hedgeSignal, price, null, true);
            } else {
                stBotOpenPosition(hedgeSignal, price, null, true);
            }
        } finally {
            setTimeout(() => isStBotBusy = false, 3000);
        }
    }
}

async function handleSuperTrendBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'supertrend_scalp') return;

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const period = parseInt(document.getElementById('cfg-st-period')?.value || '10');
        const multiplier = parseFloat(document.getElementById('cfg-st-multiplier')?.value || '3');

        if (effectiveKlines.length < period + 5) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} candle data... (${effectiveKlines.length}/${period + 5})`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const n = effectiveKlines.length;
        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== stBotLastCandleTime;

        const st = calcSupertrendRaw(effectiveKlines, period, multiplier);
        const currDir = st.direction[n - 1]; // Current tick direction
        const currSTValue = st.stValue[n - 1];
        if (currSTValue === null) return;

        const signal = currDir === 1 ? 'LONG' : 'SHORT';

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) stBotLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'supertrend_scalp');

            const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
            if (shouldFlip) {
                logEngine(`? ST-SCALP ATOMIC FLIP: Direction reversed, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('ST-Scalp Flip');
                    else stBotClosePosition(lastPrice, 'ST-Scalp Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) stBotOpenPosition(signal, lastPrice, currSTValue);
                    } else {
                        stBotOpenPosition(signal, lastPrice, currSTValue);
                    }
                    if (stBotPosition) stBotPosition.source = 'ST_SCALP';
                } finally { isStBotBusy = false; }
                return;
            }

            // Still check Trailing SL (Unique to Scalp Bot)
            if (lastPrice > pos.highestPrice) pos.highestPrice = lastPrice;
            if (lastPrice < pos.lowestPrice) pos.lowestPrice = lastPrice;

            const tpConfig = parseFloat(document.getElementById('cfg-tp')?.value || '0.5');
            const slConfig = parseFloat(document.getElementById('cfg-sl')?.value || '0.3');
            let newTrailingSL = pos.trailingSL;

            if (isLong) {
                const peakPnlPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
                if (peakPnlPct >= tpConfig) {
                    const trailFromPeak = pos.highestPrice * (1 - (slConfig / 100));
                    if (trailFromPeak > newTrailingSL) newTrailingSL = trailFromPeak;
                }
            } else {
                const peakPnlPct = ((pos.entryPrice - pos.lowestPrice) / pos.entryPrice) * 100;
                if (peakPnlPct >= tpConfig) {
                    const trailFromPeak = pos.lowestPrice * (1 + (slConfig / 100));
                    if (trailFromPeak < newTrailingSL) newTrailingSL = trailFromPeak;
                }
            }

            if ((isLong && newTrailingSL > pos.trailingSL) || (!isLong && newTrailingSL < pos.trailingSL)) {
                pos.trailingSL = newTrailingSL;
            }

            const stWaitCloseSL = document.getElementById('cfg-st-close-only')?.checked;
            const canCheckSL = !stWaitCloseSL || isNewCandle;
            if (canCheckSL && ((isLong && lastPrice < pos.trailingSL) || (!isLong && lastPrice > pos.trailingSL))) {
                logEngine(`?? ST-SCALP TRAIL SL HIT: Closing ${pos.side}...`, 'error');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('Trail SL');
                    else stBotClosePosition(lastPrice, 'Trail SL');
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [ST-SCALP] Active ${pos.side} | PnL: $${pnlUSD.toFixed(2)} | Trail SL: ${formatPrice(pos.trailingSL)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) stBotLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? ST-SCALP ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | ST=${formatPrice(currSTValue)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, currSTValue);
                } else {
                    stBotOpenPosition(signal, lastPrice, currSTValue);
                }
                if (stBotPosition) stBotPosition.source = 'ST_SCALP';
            } finally { isStBotBusy = false; }
        } else {
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `SCANNING... ST-DIR: ${currDir === 1 ? 'UP' : 'DN'}`;
        }
    } catch (err) {
        logEngine(`? ST-SCALP ERROR: ${err.message}`, 'error');
        console.error('[STBot] Analysis error:', err);
    }
}

async function handleTripleStRsiBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'triple_st_rsi') return;

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;

        // Configuration
        const st1Period = parseInt(document.getElementById('cfg-tst-p1')?.value || '10');
        const st1Mult = parseFloat(document.getElementById('cfg-tst-m1')?.value || '1');
        const st2Period = parseInt(document.getElementById('cfg-tst-p2')?.value || '11');
        const st2Mult = parseFloat(document.getElementById('cfg-tst-m2')?.value || '2');
        const st3Period = parseInt(document.getElementById('cfg-tst-p3')?.value || '12');
        const st3Mult = parseFloat(document.getElementById('cfg-tst-m3')?.value || '3');
        const rsiPeriod = parseInt(document.getElementById('cfg-tst-rsi')?.value || '14');

        if (n < Math.max(st1Period, st2Period, st3Period, rsiPeriod) + 5) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} candle data... (${n}/20)`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== tstLastCandleTime;

        // Detect Reversals on current tick
        const st1 = calcSupertrendRaw(effectiveKlines, st1Period, st1Mult);
        const st2 = calcSupertrendRaw(effectiveKlines, st2Period, st2Mult);
        const st3 = calcSupertrendRaw(effectiveKlines, st3Period, st3Mult);
        const rsi = calcRSI(effectiveKlines.map(c => c.close), rsiPeriod);

        const ci = n - 1;
        const getBias = (idx) => {
            const bull = (st1.direction[idx] === 1 ? 1 : 0) + (st2.direction[idx] === 1 ? 1 : 0) + (st3.direction[idx] === 1 ? 1 : 0);
            const bear = (st1.direction[idx] === -1 ? 1 : 0) + (st2.direction[idx] === -1 ? 1 : 0) + (st3.direction[idx] === -1 ? 1 : 0);
            return bull >= 2 ? 1 : (bear >= 2 ? -1 : 0);
        };

        const currBias = getBias(ci);
        const currRSI = rsi[ci] || 50;

        if (currBias === 0) {
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `SCANNING... BIAS: MIXED | RSI ${currRSI.toFixed(1)}`;
            return;
        }

        const signal = currBias === 1 ? 'LONG' : 'SHORT';

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) tstLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'triple_st_rsi');

            const shouldFlip = (isLong && currBias === -1) || (!isLong && currBias === 1);
            if (shouldFlip) {
                logEngine(`⚡ TRIPLE-ST ATOMIC FLIP: Bias reversed, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    // Close Main
                    if (engineTradeMode === 'real') await stBotCloseReal('Triple ST Flip');
                    else stBotClosePosition(lastPrice, 'Triple ST Flip');

                    // ATOMIC: Open new opposite immediately
                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) {
                            const slVal = (signal === 'LONG') ? Math.min(st1.stValue[ci], st2.stValue[ci], st3.stValue[ci]) : Math.max(st1.stValue[ci], st2.stValue[ci], st3.stValue[ci]);
                            stBotOpenPosition(signal, lastPrice, slVal);
                        }
                    } else {
                        const slVal = (signal === 'LONG') ? Math.min(st1.stValue[ci], st2.stValue[ci], st3.stValue[ci]) : Math.max(st1.stValue[ci], st2.stValue[ci], st3.stValue[ci]);
                        stBotOpenPosition(signal, lastPrice, slVal);
                    }
                    if (stBotPosition) stBotPosition.source = 'TRIPLE_ST';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [TRIPLE-ST] Active ${pos.side} | RSI:${currRSI.toFixed(1)} | PnL: $${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | RSI:${currRSI.toFixed(1)} | PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) tstLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            // Apply RSI Filters for *Initial* Entry to avoid extremes
            if (signal === 'LONG' && currRSI > 75) return;
            if (signal === 'SHORT' && currRSI < 25) return;

            const slVal = (signal === 'LONG') ? Math.min(st1.stValue[ci], st2.stValue[ci], st3.stValue[ci]) : Math.max(st1.stValue[ci], st2.stValue[ci], st3.stValue[ci]);
            logEngine(`⚡ TRIPLE-ST ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | SL=${formatPrice(slVal)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, slVal);
                } else {
                    stBotOpenPosition(signal, lastPrice, slVal);
                }
                if (stBotPosition) stBotPosition.source = 'TRIPLE_ST';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`⚡ TRIPLE-ST ERROR: ${err.message}`, 'error');
        console.error('[TST Bot] Error:', err);
    }
}

let pstLastCandleTime = 0;

async function handlePureSuperTrendBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'pure_supertrend') return;

        const period = parseInt(document.getElementById('cfg-st-period')?.value || '10');
        const multiplier = parseFloat(document.getElementById('cfg-st-multiplier')?.value || '3');

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < period + 5) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (Pure ST)... (${n}/${period + 5})`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== pstLastCandleTime;

        const st = calcSupertrendRaw(effectiveKlines, period, multiplier);
        const ci = n - 1;
        const evalIdx = (tradeIntervalSecs < 60 || SYNTHETIC_INTERVALS.includes(tradeInterval)) ? ci : ci - 1;
        if (evalIdx < 0) return;

        const currDir = st.direction[evalIdx]; // 1 = bullish, -1 = bearish
        const currStValue = st.stValue[evalIdx];
        if (currDir === 0 || currStValue === null) return;

        const signal = currDir === 1 ? 'LONG' : 'SHORT';

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) pstLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'pure_supertrend');

            const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
            if (shouldFlip) {
                logEngine(`? PURE ST ATOMIC FLIP: Signal reversed, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    // Close Main
                    if (engineTradeMode === 'real') await stBotCloseReal('Pure ST Flip');
                    else stBotClosePosition(lastPrice, 'Pure ST Flip');

                    // ATOMIC: Open new opposite immediately
                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) stBotOpenPosition(signal, lastPrice, currStValue);
                    } else {
                        stBotOpenPosition(signal, lastPrice, currStValue);
                    }
                    if (stBotPosition) stBotPosition.source = 'PURE_ST';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [PURE-ST] Active ${pos.side} | ST:${formatPrice(currStValue)} | PnL: $${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | ST:${formatPrice(currStValue)} | PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) pstLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? PURE ST ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | ST=${formatPrice(currStValue)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, currStValue);
                } else {
                    stBotOpenPosition(signal, lastPrice, currStValue);
                }
                if (stBotPosition) stBotPosition.source = 'PURE_ST';
            } finally { isStBotBusy = false; }
        } else {
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `SCANNING... ST-DIR: ${currDir === 1 ? 'UP' : 'DN'}`;
        }
    } catch (err) {
        logEngine(`? PURE-ST ERROR: ${err.message}`, 'error');
        console.error('[PureST] Analysis error:', err);
    }
}



function switchSymbol(symbol) {
    if (symbol === currentSymbol) return;
    currentSymbol = symbol.toUpperCase();

    const select = document.getElementById('symbol-select');
    if (select) select.value = currentSymbol;

    // Update the visual market label since the dropdown is now hidden
    const tickerLabel = document.getElementById('market-ticker-label');
    if (tickerLabel) {
        let displaySym = currentSymbol;
        if (currentSymbol.endsWith('USDT')) {
            displaySym = currentSymbol.replace('USDT', '/USDT');
        }
        tickerLabel.textContent = displaySym;
    }

    // Update header immediately
    const headerSym = document.getElementById('header-symbol');
    if (headerSym) headerSym.textContent = currentSymbol;

    updateSubmitButton();

    // Notify Central Sync Hub about new symbol
    if (typeof notifyActiveContext === 'function') notifyActiveContext();

    // Reconnect WebSockets (Deprecated but keeping hooks for compatibility)
    connectPriceWs();
    connectKlineWs();

    // Clear all synthetic candle caches for the old symbol
    if (typeof clearAllCaches === 'function') clearAllCaches();
    if (typeof comboReset === 'function') comboReset();

    // --- INSTANT UI CLEARING BEFORE FETCH ---
    candleData = [];
    if (typeof candleSeries !== 'undefined' && candleSeries) safeSetData(candleSeries, []);
    if (typeof volumeSeries !== 'undefined' && volumeSeries) safeSetData(candleSeries, []);
    if (typeof drawIndicators === 'function') drawIndicators([]);

    // Clear orderbook and recent trades UI temporarily
    const obBody = document.getElementById('ob-tbody');
    if (obBody) obBody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px; font-family: var(--mono); color: var(--text-secondary);">Loading...</td></tr>';
    const rtBody = document.getElementById('rt-tbody');
    if (rtBody) rtBody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px; font-family: var(--mono); color: var(--text-secondary);">Loading...</td></tr>';
    // ----------------------------------------

    // Reload all data components immediately
    fetchPrices();
    fetchMarketDetailedInfo();
    loadKlines();
    connectHedgeKlineWs();       // reconnect background hedge WS to new symbol
    fetchBackgroundHedgeKlines();
    fetchOrderbook();
    fetchRecentTrades();
    fetchOpenOrders();

    // Update watchlist active state in UI
    document.querySelectorAll('.watchlist-item').forEach(item => {
        item.classList.toggle('active', item.dataset.symbol === currentSymbol);
    });

    console.log(`[App] Market switched to ${currentSymbol} (Futures)`);
    updateBetSizeInfo(); // Also update the bet size info panel
}

function switchInterval(interval) {
    currentInterval = interval.toLowerCase();
    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.interval === interval);
    });
    // Restore cached data immediately for instant switching
    const ivSec = ivToSec(currentInterval);
    candleData = [...(candleCache[ivSec] || [])];
    if (candleData.length > 0) {
        safeSetData(candleSeries, candleData.map(k => ({
            time: k.time, open: k.open, high: k.high, low: k.low, close: k.close,
        })));
        safeSetData(volumeSeries, candleData.map(k => ({
            time: k.time, value: k.volume,
            color: k.close >= k.open ? '#0ecb8133' : '#f6465d33',
        })));
        drawIndicators(candleData);
        // Force chart repaint � prevents blank chart after rapid interval switching
        requestAnimationFrame(() => {
            try { chart.timeScale().fitContent(); } catch (e) { }
        });
    } else {
        candleData = [];
        if (typeof candleSeries !== 'undefined' && candleSeries) safeSetData(candleSeries, []);
        if (typeof volumeSeries !== 'undefined' && volumeSeries) safeSetData(candleSeries, []);
        if (typeof drawIndicators === 'function') drawIndicators([]);
    }

    // Notify Central Sync Hub about new interval
    if (typeof notifyActiveContext === 'function') notifyActiveContext();

    if (typeof comboReset === 'function') comboReset();
    connectKlineWs();
    loadKlines();
}

// Refresh hedge system: chart TF change affects hedge TF validation
const hedgeTfSecs = parseInt(document.getElementById('cfg-hedge-tf')?.value || '60');
candleCache[hedgeTfSecs] = []; // flush stale hedge cache
connectHedgeKlineWs();
fetchBackgroundHedgeKlines();

// ============================================================
// PRICE DISPLAY
// ============================================================
function updatePriceDisplay(price) {
    lastPrice = price;
    const priceEl = document.getElementById('live-price');
    if (priceEl) {
        priceEl.textContent = formatPrice(price);
    }
    updateMarkDiff();
    updateEstimates();
    updatePaperPnL();

    if (Math.random() < 0.1) updateBetSizeInfo();
}

function updateMarkDiff() {
    const diffEl = document.getElementById('stat-mark-diff');
    if (!diffEl || !lastPrice || !lastMarkPrice) return;

    const diff = lastPrice - lastMarkPrice;
    const diffPct = (diff / lastMarkPrice) * 100;
    const sign = diff >= 0 ? '+' : '';
    const color = diff >= 0 ? 'var(--up)' : 'var(--down)';

    diffEl.textContent = `(${sign}${diffPct.toFixed(3)}%)`;
    diffEl.style.color = color;
}

function formatPrice(price) {
    if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(6);
}

function formatNumber(num) {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
}

// ============================================================
// DATA FETCHING
// ============================================================
// Global caches for instant search filtering
async function fetchPrices() {
    try {
        const r = await fetch('/api/prices');
        const data = await r.json();

        // Cache for search filtering
        lastPricesObj = data.prices;
        lastTickersObj = data.tickers;

        // Update watchlist
        renderWatchlist(data.prices, data.tickers);

        // Update mini stats
        const ticker = data.tickers?.[currentSymbol];
        if (ticker) {
            const changeEl = document.getElementById('price-change');
            const pct = ticker.changePercent;
            if (changeEl) {
                changeEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
                changeEl.className = `price-change ${pct >= 0 ? 'up' : 'down'}`;
            }

            const highEl = document.getElementById('stat-high');
            const lowEl = document.getElementById('stat-low');
            const volBaseEl = document.getElementById('stat-vol-base');
            const volQuoteEl = document.getElementById('stat-vol-quote');
            const volAssetLbl = document.getElementById('stat-vol-asset-lbl');

            if (highEl) highEl.textContent = formatPrice(ticker.high);
            if (lowEl) lowEl.textContent = formatPrice(ticker.low);
            if (volBaseEl) volBaseEl.textContent = formatNumber(ticker.volume);
            if (volQuoteEl) volQuoteEl.textContent = formatNumber(ticker.quoteVolume);
            if (volAssetLbl) volAssetLbl.textContent = currentSymbol.replace('USDT', '');

            // Update leverage display initially
            document.getElementById('leverage-display').textContent = `${leverage}x`;
        }
    } catch (e) {
        console.error('[Prices] Error:', e);
    }
}

async function fetchMarketDetailedInfo() {
    try {
        const r = await fetch(`/api/market-info/${currentSymbol}`);
        const data = await r.json();

        const markEl = document.getElementById('stat-mark');
        const indexEl = document.getElementById('stat-index');
        const fundingEl = document.getElementById('stat-funding');
        const oiEl = document.getElementById('stat-oi');

        if (markEl && data.markPrice) {
            // Only update if lastMarkPrice is not yet set or if the element is empty, 
            // to prevent the 10s poll from overriding the 1s SSE with stale data.
            if (!lastMarkPrice || markEl.textContent === '--') {
                lastMarkPrice = parseFloat(data.markPrice);
                markEl.textContent = formatPrice(lastMarkPrice);
            }
        }
        if (indexEl && data.indexPrice) indexEl.textContent = formatPrice(parseFloat(data.indexPrice));

        if (fundingEl && data.lastFundingRate && data.nextFundingTime) {
            const fundingPct = (parseFloat(data.lastFundingRate) * 100).toFixed(4) + '%';

            // Calculate countdown
            const now = Date.now();
            let diff = data.nextFundingTime - now;
            if (diff < 0) diff = 0;
            const h = Math.floor(diff / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            const countdown = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

            fundingEl.textContent = `${fundingPct} / ${countdown}`;
            fundingEl.style.color = parseFloat(data.lastFundingRate) >= 0 ? 'var(--brand)' : 'var(--down)';
        }

        if (oiEl && data.openInterest) {
            const oiValue = parseFloat(data.openInterest) * (lastPrice || 1);
            oiEl.textContent = formatNumber(oiValue);
        }

    } catch (e) {
        console.error('[MarketInfo] Error:', e);
    }
}

async function fetchBalance() {
    try {
        const r = await fetch('/api/balance');
        const data = await r.json();

        if (data.error) {
            document.getElementById('header-balance').textContent = 'Error';
            return;
        }

        balanceData = data;
        const usdt = data.totalUSDT || 0;

        let unrealized = data.unrealizedPnL || 0;
        let sign = unrealized >= 0 ? '+' : '';
        let color = unrealized >= 0 ? 'var(--up)' : 'var(--down)';

        document.getElementById('header-balance').textContent = `${usdt.toFixed(2)} USDT`;
        if (engineTradeMode === 'real') {
            document.getElementById('header-pnl').textContent = `${sign}$${unrealized.toFixed(2)}`;
            document.getElementById('header-pnl').style.color = color;
        }

        document.getElementById('bal-usdt').textContent = `${usdt.toFixed(2)} USDT`;

        // Render all non-zero balances
        const container = document.getElementById('balance-details');
        if (container && data.balances) {
            container.innerHTML = data.balances
                .filter(b => b.total > 0.001) // Compact: Hide dust
                .map(b => `
                <div class="balance-item">
                    <span>${b.asset} <span style="font-size:8px; padding:1px 3px; background:var(--bg-elevated); border-radius:2px; color:var(--text-secondary); margin-left:2px;">${b.type || 'FUTURES'}</span></span>
                    <span class="mono">${b.total < 0.1 ? b.total.toFixed(6) : b.total.toFixed(4)}</span>
                </div>
            `).join('');
        }

        // Ensure bot Bet Size panel has updated values
        updateBetSizeInfo();
    } catch (e) {
        console.error('[Balance] Error:', e);
    }
}

async function fetchExchangeInfo() {
    try {
        const r = await fetch('/api/futures/exchange-info');
        const data = await r.json();
        if (data.symbols) {
            data.symbols.forEach(s => {
                let minNotional = 5.0;
                const notionalFilter = s.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
                if (notionalFilter) minNotional = parseFloat(notionalFilter.notional);

                symbolFilters[s.symbol] = {
                    quantityPrecision: s.quantityPrecision,
                    pricePrecision: s.pricePrecision,
                    minNotional: minNotional
                };
            });
            console.log('[App] Loaded Futures Exchange Info');
            updateBetSizeInfo(); // refresh UI with minimum values
        }
    } catch (e) {
        console.error('[ExchangeInfo] Error:', e);
    }
}

async function fetchPositionMode() {
    try {
        const r = await fetch('/api/futures/position-mode');
        const data = await r.json();
        if (data && typeof data.dualSidePosition !== 'undefined') {
            const prevMode = typeof isHedgeMode !== 'undefined' ? isHedgeMode : false;
            isHedgeMode = data.dualSidePosition;
            if (isHedgeMode !== prevMode) {
                console.log(`[App] Account Position Mode synced: ${isHedgeMode ? 'Hedge Mode' : 'One-Way Mode'}`);
            }
        }
    } catch (e) {
        console.error('[PositionMode] Error:', e);
    }
}

async function fetchOrderbook() {
    try {
        const r = await fetch(`/api/orderbook/${currentSymbol}?limit=10`);
        const data = await r.json();

        if (!data.asks || !data.bids) return;

        const asksContainer = document.getElementById('ob-asks');
        const bidsContainer = document.getElementById('ob-bids');
        const spreadEl = document.getElementById('ob-spread-value');

        // Asks (sell orders) � reversed so lowest price is at bottom
        const asks = data.asks.slice(0, 8).reverse();
        const maxAskQty = Math.max(...asks.map(a => parseFloat(a[1])));
        asksContainer.innerHTML = asks.map(([price, qty]) => {
            const pct = (parseFloat(qty) / maxAskQty * 100).toFixed(0);
            return `<div class="ob-row ask">
                <span class="ob-price">${formatPrice(parseFloat(price))}</span>
                <span>${parseFloat(qty).toFixed(5)}</span>
                <span>${(parseFloat(price) * parseFloat(qty)).toFixed(2)}</span>
                <div class="ob-bar" style="width:${pct}%"></div>
            </div>`;
        }).join('');

        // Bids (buy orders)
        const bids = data.bids.slice(0, 8);
        const maxBidQty = Math.max(...bids.map(b => parseFloat(b[1])));
        bidsContainer.innerHTML = bids.map(([price, qty]) => {
            const pct = (parseFloat(qty) / maxBidQty * 100).toFixed(0);
            return `<div class="ob-row bid">
                <span class="ob-price">${formatPrice(parseFloat(price))}</span>
                <span>${parseFloat(qty).toFixed(5)}</span>
                <span>${(parseFloat(price) * parseFloat(qty)).toFixed(2)}</span>
                <div class="ob-bar" style="width:${pct}%"></div>
            </div>`;
        }).join('');

        // Spread
        if (data.asks.length && data.bids.length) {
            const bestAsk = parseFloat(data.asks[0][0]);
            const bestBid = parseFloat(data.bids[0][0]);
            const spread = bestAsk - bestBid;
            const spreadPct = ((spread / bestBid) * 100).toFixed(4);
            spreadEl.textContent = `Spread: ${formatPrice(spread)} (${spreadPct}%)`;
        }

    } catch (e) {
        console.error('[OrderBook] Error:', e);
    }
}

async function fetchRecentTrades() {
    try {
        const r = await fetch(`/api/recent-trades/${currentSymbol}?limit=20`);
        const data = await r.json();

        if (!Array.isArray(data)) return;

        const container = document.getElementById('rt-list');
        container.innerHTML = data.reverse().map(t => {
            const isBuy = !t.isBuyerMaker;
            const time = new Date(t.time).toLocaleTimeString();
            return `<div class="rt-row ${isBuy ? 'buy' : 'sell'}">
                <span class="rt-price">${formatPrice(parseFloat(t.price))}</span>
                <span>${parseFloat(t.qty).toFixed(5)}</span>
                <span style="color:var(--text-muted)">${time}</span>
            </div>`;
        }).join('');

    } catch (e) {
        console.error('[RecentTrades] Error:', e);
    }
}

async function fetchOpenOrders() {
    try {
        const r = await fetch('/api/open-orders');
        const data = await r.json();

        const container = document.getElementById('open-orders-container');
        if (!Array.isArray(data) || data.length === 0) {
            container.innerHTML = '<div class="empty-state">No open orders</div>';
            return;
        }

        container.innerHTML = data.map(o => `
            <div class="order-item">
                <span class="oi-side ${o.side.toLowerCase()}">${o.side}</span>
                <span class="mono" style="flex:1; padding:0 8px;">
                    ${o.symbol} @ ${formatPrice(parseFloat(o.price))}
                </span>
                <span class="mono" style="font-size:10px; color:var(--text-muted);">
                    ${parseFloat(o.origQty).toFixed(4)}
                </span>
                <button class="oi-cancel" onclick="cancelOrder('${o.symbol}', ${o.orderId})">?</button>
            </div>
        `).join('');

    } catch (e) {
        console.error('[OpenOrders] Error:', e);
    }
}

async function checkConnection() {
    try {
        const r = await fetch('/api/status');
        const data = await r.json();
        isWsConnected = data.ws_connected;
        isServerless = data.serverless || false;

        const badge = document.getElementById('connection-status');
        if (data.ws_connected) {
            badge.className = 'connection-badge connected';
            badge.innerHTML = `<span class="pulse"></span><span>Live Hub: Online ${isServerless ? '(Direct Mode)' : ''}</span>`;
        } else if (isServerless) {
            // In serverless mode, we might be connected directly via JS even if backend hub is "offline"
            badge.className = 'connection-badge connected';
            badge.style.background = 'var(--brand)';
            badge.innerHTML = '<span class="pulse"></span><span>Binance Direct: Active</span>';

            // CRITICAL: If we are in serverless mode but not yet connected to direct WebSockets, trigger them now!
            if (!window.directWsInitialized) {
                console.log("?? Serverless detected: Initializing Direct WebSockets...");
                initDirectBinanceWs();
            }
        } else {
            badge.className = 'connection-badge';
            badge.innerHTML = '<span class="pulse"></span><span>WS Offline (REST Fallback)</span>';
        }

        // Update settings modal
        const statusEl = document.getElementById('cfg-api-status');
        if (statusEl) {
            if (isWsConnected) {
                statusEl.textContent = isServerless ? '🌐 Binance Direct Active' : '🌐 WebSocket Online';
                statusEl.className = 'badge green';
            } else {
                statusEl.textContent = '🔄 WS Connecting...';
                statusEl.className = 'badge yellow';
            }

            if (!data.api_ready) {
                statusEl.textContent += ' (Key Missing)';
                statusEl.className = 'badge red';
            }
        }
    } catch (e) {
        const badge = document.getElementById('connection-status');
        if (badge) {
            badge.className = 'connection-badge error';
            badge.innerHTML = '<span class="pulse"></span><span>Server Offline</span>';
        }
    }
}

function initDirectBinanceWs() {
    if (window.directWsInitialized) return;
    console.log("?? FALLBACK: Initializing Direct Binance WebSockets...");
    isServerless = true; // Force mode if we triggered fallback
    window.directWsInitialized = true;
    isWsConnected = true; // Mark as connected for watchdog

    connectPriceWs();
    connectKlineWs();
    connectOrderbookWs();
    connectTickerWs();
    connectMarkPriceWs();
    connectHedgeKlineWs();
}

// ============================================================
// WATCHLIST
// ============================================================
function renderWatchlist(prices, tickers) {
    const container = document.getElementById('watchlist-container');
    const searchInput = document.getElementById('market-search');
    if (!container) return;

    // If no tickers yet, show loading
    if (!tickers || Object.keys(tickers).length === 0) {
        if (!container.innerHTML || container.children.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:15px; text-align:center; font-size:11px; opacity:0.5;">🔄 Loading Futures Markets...</div>';
        }
        return;
    }

    const searchTerm = (searchInput?.value || '').toUpperCase();

    // Get all USDT symbols from tickers (already filtered by backend for perpetuals)
    let symbols = Object.keys(tickers).filter(sym => sym.endsWith('USDT'));

    if (searchTerm) {
        symbols = symbols.filter(sym => sym.includes(searchTerm));
    }

    // Sort by 24h volume descending
    symbols.sort((a, b) => (tickers[b]?.quoteVolume || 0) - (tickers[a]?.quoteVolume || 0));

    if (symbols.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:15px; text-align:center; font-size:11px; opacity:0.5;">🔍 No perpetuals found</div>';
        return;
    }

    // Limit to 100 for performance
    const displaySymbols = symbols.slice(0, 100);

    container.innerHTML = displaySymbols.map(sym => {
        const price = prices?.[sym] || tickers?.[sym]?.price || 0;
        const ticker = tickers?.[sym] || {};
        const pct = ticker.changePercent || 0;
        const isActive = sym === currentSymbol;

        return `<div class="watchlist-item ${isActive ? 'active' : ''}" data-symbol="${sym}" onclick="switchSymbol('${sym}')" style="padding:4px 8px;">
            <div>
                <div class="wl-symbol" style="display:flex; align-items:center; gap:3px; font-size:11px;">
                    ${sym.replace('USDT', '')}
                    <span style="font-size:7px; padding:0px 2px; background:var(--bg-elevated); border-radius:2px; color:var(--text-secondary); font-weight:normal;">PERP</span>
                </div>
                <div class="wl-change ${pct >= 0 ? 'up' : 'down'}" style="font-size:9px;">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</div>
            </div>
            <div class="wl-price" style="display: flex; flex-direction: column; align-items: flex-end;">
                <span style="font-family:var(--mono); font-weight:500; font-size:10px; color:${pct >= 0 ? 'var(--up)' : 'var(--down)'}">${formatPrice(price)}</span>
                <span style="font-size:8px; opacity:0.6; color:var(--text-secondary)">Vol: ${formatNumber(ticker.quoteVolume || 0)}</span>
            </div>
        </div>`;
    }).join('');
}

// ============================================================
// ENVIRONMENT SWITCHER
// ============================================================
function switchEnv(port) {
    const currentPort = parseInt(location.port) || 5000;
    const targetPort = parseInt(port);
    if (targetPort === currentPort) return; // already here
    const url = `${location.protocol}//${location.hostname}:${targetPort}`;
    window.open(url, `env_${targetPort}`);
}

// Set the current env button label on load
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('env-btn-current');
    if (btn) btn.textContent = ':' + (location.port || 5000);
});

// Attach event listener for search input
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('market-search')?.addEventListener('input', () => {
        // Force a re-render instantly using cached data
        if (Object.keys(lastTickersObj).length > 0) {
            renderWatchlist(lastPricesObj, lastTickersObj);
        }
    });
});

// ============================================================
// ORDER PLACEMENT
// ============================================================
async function placeOrder() {
    const margin = parseFloat(document.getElementById('order-amount')?.value || 0);
    if (margin <= 0) {
        showToast('Enter a valid amount', 'error');
        return;
    }
    const leverage = parseInt(document.getElementById('leverage-slider')?.value || 10);
    const amount = margin * leverage; // Total Notional size

    // Map UI actions to logic side
    const logicSide = currentSide === 'BUY' ? 'LONG' : 'SHORT';

    // --- Paper Trading (Simulation Tab) ---
    if (currentOrderType === 'sim') {
        const marginRequired = amount / leverage;

        if (paperBalance < marginRequired) {
            showToast(`Insufficient paper balance. Need $${marginRequired.toFixed(2)}`, 'error');
            return;
        }

        paperBalance -= marginRequired;
        const qty = amount / lastPrice;

        const pos = {
            id: Date.now(),
            symbol: currentSymbol,
            side: logicSide,
            entryPrice: lastPrice,
            amount: amount,                 // Total position size (Leveraged)
            margin: marginRequired,         // Actual margin used
            leverage: leverage,
            qty: qty,
            time: new Date(),
            timeframe: currentInterval
        };
        paperPositions.push(pos);
        showToast(`? Paper ${logicSide} opened! Margin: $${marginRequired.toFixed(2)}, Size: $${amount}`, 'success');

        // Auto-switch to Positions tab
        document.querySelector('[data-list="positions"]')?.click();
        renderPaperPositions();
        return;
    }
    // --- End Paper Trading ---

    const params = {
        symbol: currentSymbol,
        side: currentSide,
        type: currentOrderType === 'market' ? 'MARKET' : 'LIMIT',
    };
    if (isHedgeMode) {
        params.positionSide = logicSide;
    }

    const precision = symbolFilters[currentSymbol]?.quantityPrecision ?? 0;

    if (currentOrderType === 'market') {
        // Futures requires quantity for both sides. quoteOrderQty is spot-only.
        if (lastPrice > 0) {
            params.quantity = await safeQuantity(currentSymbol, amount / lastPrice);
        } else {
            showToast('Fetching price... try again', 'warning');
            return;
        }
    } else if (currentOrderType === 'limit') {
        const price = parseFloat(document.getElementById('order-price').value || 0);
        if (price <= 0) {
            showToast('Enter a valid price', 'error');
            return;
        }
        params.price = price;
        params.quantity = await safeQuantity(currentSymbol, amount / price);
        params.timeInForce = 'GTC';
    } else if (currentOrderType === 'stop') {
        const price = parseFloat(document.getElementById('order-price').value || 0);
        const stopPrice = parseFloat(document.getElementById('stop-price').value || 0);
        if (price <= 0 || stopPrice <= 0) {
            showToast('Enter valid prices', 'error');
            return;
        }
        params.type = 'STOP_LOSS_LIMIT';
        params.price = price;
        params.stopPrice = stopPrice;
        params.quantity = (amount / price).toFixed(precision);
        params.timeInForce = 'GTC';
    }

    try {
        showToast(`Placing ${currentSide} order...`, 'info');
        const r = await fetch('/api/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const result = await r.json();

        if (result.orderId) {
            showToast(`? Order placed: ${result.orderId}`, 'success');
            fetchOpenOrders();
            fetchBalance();
        } else {
            showToast(`? ${result.msg || result.error || 'Order failed'}`, 'error');
        }
    } catch (e) {
        showToast(`? Order error: ${e.message}`, 'error');
    }
}

// ============================================================
// UI DYNAMIC UPDATES
// ============================================================
function updateBetSizeInfo() {
    const infoEl = document.getElementById('bet-size-info');

    // Balance computation
    let balance = 0;
    if (engineTradeMode === 'real') {
        balance = balanceData?.totalUSDT || 0;
    } else {
        balance = typeof paperBalance !== 'undefined' ? paperBalance : 1000;
    }

    const minNotional = symbolFilters[currentSymbol]?.minNotional || 5.0;

    // --- AUTOMATED BOT HUD ---
    if (infoEl) {
        const betSize = parseFloat(document.getElementById('cfg-bet-size')?.value || '10');
        const engLev = parseInt(document.getElementById('cfg-engine-leverage')?.value || '10');
        const botNotional = betSize * engLev;

        const pct = balance > 0 ? ((betSize / balance) * 100).toFixed(2) : '0.00';

        let pctColor = 'var(--text-secondary)';
        if (parseFloat(pct) > 100) pctColor = 'var(--down)';

        let minColor = 'var(--up)';
        if (botNotional < minNotional) minColor = 'var(--down)';

        infoEl.innerHTML = `Bal: $${balance.toFixed(2)} | Bet: <span style="color:${pctColor}">${pct}%</span> | Lev Bet: $${botNotional.toFixed(2)} | Min: <span style="color:${minColor}">$${minNotional.toFixed(2)}</span>`;
    }

    // --- MANUAL TRADING HUD ---
    const manInfoEl = document.getElementById('manual-bet-size-info');
    if (manInfoEl) {
        const manMargin = parseFloat(document.getElementById('order-amount')?.value || '10');
        const manLev = parseInt(document.getElementById('leverage-slider')?.value || '10');
        const manNotional = manMargin * manLev;

        const manPct = balance > 0 ? ((manMargin / balance) * 100).toFixed(2) : '0.00';

        let manPctColor = 'var(--text-secondary)';
        if (parseFloat(manPct) > 100) manPctColor = 'var(--down)';

        let manMinColor = 'var(--up)';
        if (manNotional < minNotional) manMinColor = 'var(--down)';

        manInfoEl.innerHTML = `Bal: $${balance.toFixed(2)} | Bet: <span style="color:${manPctColor}">${manPct}%</span> | Lev Bet: $${manNotional.toFixed(2)} | Min: <span style="color:${manMinColor}">$${minNotional.toFixed(2)}</span>`;
    }
}

async function cancelOrder(symbol, orderId) {
    try {
        const r = await fetch('/api/cancel-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, orderId })
        });
        const result = await r.json();
        if (result.orderId) {
            showToast(`Order ${orderId} cancelled`, 'success');
            fetchOpenOrders();
        } else {
            showToast(`Cancel failed: ${result.msg || result.error}`, 'error');
        }
    } catch (e) {
        showToast(`Cancel error: ${e.message}`, 'error');
    }
}

async function cancelAllOrders() {
    try {
        const r = await fetch('/api/cancel-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: currentSymbol })
        });
        showToast(`All ${currentSymbol} orders cancelled`, 'success');
        fetchOpenOrders();
    } catch (e) {
        showToast(`Cancel all error: ${e.message}`, 'error');
    }
}

// ============================================================
// PAPER TRADING LOGIC
// ============================================================
function renderPaperPositions() {
    const balTitle = document.getElementById('bot-ledger-title');
    const balInput = document.getElementById('paper-balance-input');
    const balDisplay = document.getElementById('paper-balance-display');

    if (balTitle) {
        balTitle.textContent = (engineTradeMode === 'sim') ? 'Paper' : 'Real';
    }

    if (balDisplay) {
        balDisplay.textContent = '$' + paperBalance.toFixed(2);
    }

    if (balInput && document.activeElement !== balInput) {
        balInput.value = paperBalance.toFixed(0);
    }

    // --- PNL CALCULATION ---
    let totalRealized = 0;
    paperTradeHistory.forEach(t => totalRealized += (t.pnl || 0));

    let totalUnrealized = 0;
    paperPositions.forEach(p => {
        const isLong = p.side === 'LONG' || p.side === 'BUY';
        const curPrice = (p.symbol === currentSymbol) ? lastPrice : p.entryPrice;
        const diff = isLong ? curPrice - p.entryPrice : p.entryPrice - curPrice;
        const qty = p.amount / p.entryPrice;
        totalUnrealized += (qty * diff);
    });

    const realizedEl = document.getElementById('paper-realized-pnl');
    const unrealizedEl = document.getElementById('paper-unrealized-pnl');

    if (realizedEl) {
        realizedEl.textContent = (totalRealized >= 0 ? '+' : '') + '$' + totalRealized.toFixed(2);
        realizedEl.style.color = totalRealized >= 0 ? 'var(--up)' : 'var(--down)';
    }
    if (unrealizedEl) {
        unrealizedEl.textContent = (totalUnrealized >= 0 ? '+' : '') + '$' + totalUnrealized.toFixed(2);
        unrealizedEl.style.color = totalUnrealized >= 0 ? 'var(--up)' : 'var(--down)';
    }

    // --- CHART PNL LINES ---
    if (typeof updateChartPositionLines === 'function') {
        updateChartPositionLines(paperPositions);
    }

    const container = document.getElementById('positions-list');
    if (!container) return;

    if (paperPositions.length === 0 && paperTradeHistory.length === 0) {
        container.innerHTML = '<div class="empty-state">No open positions</div>';
        return;
    }

    let html = '';

    if (paperPositions.length === 0) {
        html += '<div class="empty-state" style="padding:6px;">No open positions</div>';
    }

    // --- BINANCE FUTURES STYLE POSITION CARDS ---
    const positionsHtml = paperPositions.map(p => {
        let pnl = 0;
        let pnlPct = 0;
        const isLong = p.side === 'LONG' || p.side === 'BUY';
        const curPrice = (p.symbol === currentSymbol) ? lastPrice : p.entryPrice;
        const diff = isLong ? curPrice - p.entryPrice : p.entryPrice - curPrice;
        const qty = p.amount / p.entryPrice;
        pnl = qty * diff;
        pnlPct = (diff / p.entryPrice) * 100;
        const roi = (pnl / p.margin) * 100;

        const pnlColor = pnl >= 0 ? 'var(--up)' : 'var(--down)';
        const sign = pnl >= 0 ? '+' : '';
        const liqPrice = calculateLiquidationPrice(p.entryPrice, p.leverage, p.side);
        const sideLabel = isLong ? 'Cross Long' : 'Cross Short';
        const sideColor = isLong ? 'var(--up)' : 'var(--down)';
        const modeTag = p.source === 'REAL_BOT' ? 'LIVE' : p.source.includes('BOT') ? 'BOT' : 'SIM';
        const tagBg = modeTag === 'LIVE' ? 'var(--down)' : modeTag === 'BOT' ? 'var(--brand)' : 'var(--accent)';

        const botSL = p.trailingSL || ((stBotPosition && stBotPosition.id === p.id) ? stBotPosition.trailingSL : null);
        const slDisplay = botSL ? `SL: <span style="color:var(--down)">${formatPrice(botSL)}</span>` : `SL: --`;

        return `
            <div class="order-item" style="display:flex; align-items:center; gap:12px; padding:6px 12px; border:1px solid var(--border); border-radius:4px; font-size:10px; flex: 1 1 100%; background: var(--bg-card); min-height: 48px; border-left: 3px solid ${sideColor};">
                <!-- Group 1: Symbol & Side -->
                <div style="display:flex; flex-direction:column; min-width:85px;">
                    <div style="display:flex; align-items:center; gap:4px;">
                        <span style="background:${tagBg}; color:#fff; font-size:7px; padding:1px 4px; border-radius:2px; font-weight:700;">${modeTag}</span>
                        <span class="mono" style="font-weight:700; font-size:11px;">${p.symbol.replace('USDT', '')}</span>
                    </div>
                    <div style="font-size:8px; color:var(--text-secondary); margin-top:2px;">
                        <span style="color:${sideColor}; font-weight:700; text-transform:uppercase;">${p.side}</span> Perp ${p.leverage}x
                        <span onclick="switchInterval('${p.timeframe || '1m'}')" style="margin-left:4px; background:rgba(255,255,255,0.05); padding:1px 3px; border-radius:2px; font-size:7.5px; color:var(--text-primary); border:1px solid rgba(255,255,255,0.1); cursor:pointer; transition:0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.15)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'" title="Switch Chart to ${p.timeframe || '1m'}">${p.timeframe || '---'}</span>
                    </div>
                </div>

                <!-- Group 2: Size & Entry -->
                <div style="display:flex; flex:1; gap:20px; justify-content:space-around; padding: 0 10px;">
                    <div style="display:flex; flex-direction:column;">
                        <span style="color:var(--text-secondary); font-size:8px; text-transform:uppercase; letter-spacing:0.3px;">Size</span>
                        <span class="mono" style="font-weight:600; font-size:11px;">${p.amount.toFixed(2)}</span>
                    </div>
                    <div style="display:flex; flex-direction:column;">
                        <span style="color:var(--text-secondary); font-size:8px; text-transform:uppercase; letter-spacing:0.3px;">Entry</span>
                        <span class="mono" style="font-size:11px;">${formatPrice(p.entryPrice)}</span>
                    </div>
                    <div style="display:flex; flex-direction:column;">
                        <span style="color:var(--text-secondary); font-size:8px; text-transform:uppercase; letter-spacing:0.3px;">Mark</span>
                        <span class="mono" style="font-size:11px;">${formatPrice(curPrice)}</span>
                    </div>
                    <div style="display:flex; flex-direction:column;">
                        <span style="color:var(--text-secondary); font-size:8px; text-transform:uppercase; letter-spacing:0.3px;">Liq</span>
                        <span class="mono" style="color:var(--down); font-size:11px;">${formatPrice(liqPrice)}</span>
                    </div>
                </div>

                <!-- Group 3: PNL -->
                <div style="display:flex; flex-direction:column; min-width:125px; text-align:right;">
                    <span style="color:var(--text-secondary); font-size:8px; text-transform:uppercase; letter-spacing:0.3px;">PNL (ROE%)</span>
                    <span class="mono" style="color:${pnlColor}; font-weight:700; font-size:12px;">${sign}${pnl.toFixed(2)} (${sign}${roi.toFixed(1)}%)</span>
                    <div style="font-size:8px; color:var(--text-secondary);">${slDisplay}</div>
                </div>

                <!-- Group 4: Close Button -->
                <div style="display:flex; align-items:center; gap:8px; min-width:80px; border-left:1px solid var(--border); padding-left:15px; margin-left:5px;">
                    <button class="oi-cancel" onclick="closePaperPosition(${p.id})" style="background:var(--down); color:#fff; border:none; padding:4px 12px; border-radius:3px; font-size:10px; cursor:pointer; font-weight:700; transition:0.2s;">Close</button>
                </div>
            </div>
        `;
    }).join('');

    // --- MERGED ORDER & POSITION HISTORY ---
    if (paperTradeHistory.length > 0) {
        html += `<div style="display:flex; flex-wrap:wrap; gap:8px; padding:4px;">${positionsHtml}</div>`;

        let wins = 0;
        let totalPnl = 0;
        paperTradeHistory.forEach(t => {
            const pnl = parseFloat(t.pnl || 0);
            if (isNaN(pnl)) return;
            if (pnl > 0) wins++;
            totalPnl += pnl;
        });
        const winRate = ((wins / paperTradeHistory.length) * 100).toFixed(1);
        const pnlSign = totalPnl >= 0 ? '+' : '';
        const pnlCol = totalPnl >= 0 ? 'var(--up)' : 'var(--down)';

        html += `
        <div style="padding:8px 12px; font-size:11px; border-top:1px solid var(--border); margin-top:8px; width:100%;">
            <div style="color:var(--text-secondary); margin-bottom:6px; font-weight:600; font-size:10px; text-transform:uppercase; letter-spacing:0.5px;">📊 Position History Stats</div>
            <div style="display:flex; justify-content:space-between; background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:4px; border:1px solid var(--border);">
                <span>Win Rate: <strong style="color:var(--text-primary)">${winRate}%</strong> <span style="font-size:9px; color:var(--text-muted);">(${wins}/${paperTradeHistory.length})</span></span>
                <span>Net PnL: <strong style="color:${pnlCol}">${pnlSign}$${totalPnl.toFixed(2)}</strong></span>
            </div>
        </div>`;

        const renderItem = (t, isHedgeTrack) => {
            const pnlVal = parseFloat(t.pnl || 0);
            const pnlColor = pnlVal >= 0 ? 'var(--up)' : 'var(--down)';
            const sideColor = t.side === 'LONG' || t.side === 'BUY' ? 'var(--up)' : 'var(--down)';
            const sideLabel = (t.side === 'LONG' || t.side === 'BUY') ? 'Cross Long' : 'Cross Short';
            const pnlStr = pnlVal >= 0 ? `+$${pnlVal.toFixed(2)}` : `-$${Math.abs(pnlVal).toFixed(2)}`;
            const pnlPct = parseFloat(t.pnlPct || 0);
            const roiStr = !isNaN(pnlPct) ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : '0.00%';
            const modeLabel = (t.source === 'REAL_BOT') ? '<span style="color:var(--down);font-weight:700;">REAL</span>' : '<span style="color:var(--accent);">SIM</span>';

            let counterpartHtml = '';
            if (t.counterpartState && t.counterpartState.pnl !== undefined) {
                const cmpSign = t.counterpartState.pnl >= 0 ? '+' : '';
                const cmpCol = t.counterpartState.pnl >= 0 ? 'var(--up)' : 'var(--down)';
                const owner = isHedgeTrack ? 'Main' : 'Hedge';
                counterpartHtml = ` | ${owner} was <span style="font-weight:600; color:${cmpCol};">${cmpSign}$${t.counterpartState.pnl.toFixed(2)} (${cmpSign}${t.counterpartState.pnlPct.toFixed(2)}%)</span>`;
            } else if (t.inheritedMainState && t.inheritedMainState.pnl !== undefined) {
                const cmpSign = t.inheritedMainState.pnl >= 0 ? '+' : '';
                const cmpCol = t.inheritedMainState.pnl >= 0 ? 'var(--up)' : 'var(--down)';
                counterpartHtml = ` | Old Main cut at <span style="font-weight:600; color:${cmpCol};">${cmpSign}$${t.inheritedMainState.pnl.toFixed(2)} (${cmpSign}${t.inheritedMainState.pnlPct.toFixed(2)}%)</span>`;
            }

            let reasonHtml = '';
            if (isHedgeTrack || t.isHedge || (t.id && String(t.id).includes('_HEDGE')) || (t.id && String(t.id).includes('_PROMOTED'))) {
                const labelColor = (t.id && String(t.id).includes('_PROMOTED')) ? 'var(--brand)' : 'var(--text-secondary)';
                const labelText = t.reason || (isHedgeTrack ? 'Hedge Reversal' : 'Hedge Position');
                reasonHtml = `<div style="font-size:8px; color:${labelColor}; text-align:right; margin-top:2px;">? ${labelText}${counterpartHtml}</div>`;
            } else if (t.reason) {
                reasonHtml = `<div style="font-size:8px; color:var(--text-secondary); text-align:right; margin-top:2px;">? ${t.reason}${counterpartHtml}</div>`;
            } else if (counterpartHtml) {
                reasonHtml = `<div style="font-size:8px; color:var(--text-secondary); text-align:right; margin-top:2px;">? Closed${counterpartHtml}</div>`;
            }

            return `
                <div style="padding:6px 10px; border-bottom:1px solid var(--border); font-size:10px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            ${modeLabel}
                            <span class="mono" style="font-weight:600;">${t.symbol || currentSymbol}</span>
                            <span style="font-size:8px; color:var(--text-secondary);">Perp ${t.leverage}x</span>
                            <span style="color:${sideColor}; font-weight:600;">${sideLabel}</span>
                            <span style="font-size:8px; background:var(--bg-elevated); padding:1px 4px; border-radius:3px; color:var(--text-secondary);">Closed</span>
                        </div>
                        <span class="mono" style="color:${pnlColor}; font-weight:700;">${pnlStr}</span>
                    </div>
                    ${reasonHtml}
                    <div style="display:flex; gap:16px; color:var(--text-secondary); font-size:9px; margin-top:3px;">
                        <span>Entry: <span class="mono" style="color:var(--text-primary)">${formatPrice(t.entryPrice)}</span></span>
                        <span>Close: <span class="mono" style="color:var(--text-primary)">${formatPrice(t.exitPrice)}</span></span>
                        <span>ROI: <span class="mono" style="color:${pnlColor}">${roiStr}</span></span>
                        <span>${t.closedAt || ''}</span>
                    </div>
                </div>
            `;
        };

        const mainHistory = paperTradeHistory.filter(t => !t.isHedge && (!t.id || !String(t.id).includes('_HEDGE')));
        const hedgeHistory = paperTradeHistory.filter(t => t.isHedge || (t.id && String(t.id).includes('_HEDGE')));

        if (mainHistory.length > 0) {
            html += mainHistory.slice(0, 15).map(t => renderItem(t, false)).join('');
        }

        if (hedgeHistory.length > 0) {
            html += `
            <div style="padding:6px 8px; font-size:10px; border-bottom:1px solid var(--border); background:rgba(240,185,11,0.06);">
                <div style="color:var(--brand); display:flex; align-items:center; gap:4px; font-weight:600;">
                    ??? Hedge Tracking 
                    <span style="font-size:8px; color:var(--text-secondary); font-weight:400;">(${hedgeHistory.length} trades)</span>
                </div>
            </div>`;
            html += hedgeHistory.slice(0, 15).map(t => renderItem(t, true)).join('');
        }
    } else {
        html += positionsHtml;
    }

    container.innerHTML = html;
}

/**
 * Updates or creates horizontal price lines on the chart for open positions.
 * Synchronizes for Paper SIM, REAL Bot, and HEDGE positions.
 */
function updateChartPositionLines(manualPositions) {
    if (typeof candleSeries === 'undefined' || !candleSeries) return;

    // 1. Unified Collection of ALL active positions
    const allPositions = [...(manualPositions || [])];
    if (stBotPosition && stBotPosition.symbol === currentSymbol) allPositions.push(stBotPosition);
    if (stBotHedgePosition && stBotHedgePosition.symbol === currentSymbol) allPositions.push(stBotHedgePosition);

    const activeIds = new Set();
    const cleanCurrent = currentSymbol.replace('/', '').toUpperCase();

    allPositions.forEach(p => {
        if (!p || !p.symbol) return;
        const cleanSymbol = p.symbol.replace('/', '').toUpperCase();

        // Only show lines for the current symbol
        if (cleanSymbol !== cleanCurrent) return;

        activeIds.add(String(p.id));

        const isLong = p.side === 'LONG' || p.side === 'BUY';
        // Support both Bot (quantity) and Paper (qty) keys
        const qty = p.quantity || p.qty || (p.amount / p.entryPrice);
        const pnl = isLong ? (lastPrice - p.entryPrice) * qty : (p.entryPrice - lastPrice) * qty;

        // PnL & ROI Calculation (Leveraged)
        const margin = p.margin || (p.amount / (p.leverage || 10));
        const roi = margin > 0 ? (pnl / margin) * 100 : 0;

        const color = isLong ? '#0ecb81' : '#f6465d';
        const sign = pnl >= 0 ? '+' : '';
        const roiSign = roi >= 0 ? '+' : '';
        const label = `${p.side} ${qty.toFixed(3)} | P&L: ${sign}$${pnl.toFixed(2)} (${roiSign}${roi.toFixed(1)}%)`;

        if (positionPriceLines[p.id]) {
            // Update existing line
            positionPriceLines[p.id].applyOptions({
                price: p.entryPrice,
                title: label,
                color: color
            });
        } else {
            // Create new line
            positionPriceLines[p.id] = candleSeries.createPriceLine({
                price: p.entryPrice,
                color: color,
                lineWidth: 1,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: label
            });
        }
    });

    // 2. Remove lines for positions that are closed or for other symbols
    Object.keys(positionPriceLines).forEach(id => {
        if (!activeIds.has(String(id))) {
            if (positionPriceLines[id]) {
                try {
                    candleSeries.removePriceLine(positionPriceLines[id]);
                } catch (e) {
                    console.error('Error removing price line:', e);
                }
                delete positionPriceLines[id];
            }
        }
    });
}


function resetPaperBalance() {
    const input = document.getElementById('paper-balance-input');
    const newBal = parseFloat(input?.value || 1000);
    paperBalance = newBal;
    paperPositions = [];
    paperTradeHistory = [];
    renderPaperPositions();
    showToast(`Paper balance reset to $${newBal.toFixed(2)}`, 'info');
}

// Sync paper balance when user manually edits the input
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('paper-balance-input')?.addEventListener('change', (e) => {
        paperBalance = parseFloat(e.target.value) || 0;
        renderPaperPositions();
    });
});

function updatePaperPnL() {
    // Throttle re-renders to max once per 250ms to avoid DOM overload during high-frequency price updates
    const now = Date.now();
    if (window._lastPnlRender && now - window._lastPnlRender < 250) return;
    window._lastPnlRender = now;
    if (paperPositions.some(p => p.symbol === currentSymbol)) {
        renderPaperPositions();
    }
}

function closePaperPosition(id) {
    const index = paperPositions.findIndex(p => p.id === id);
    if (index === -1) return;

    const p = paperPositions[index];

    // If this is a LIVE position, we must execute the closure on Binance
    if ((p.source === 'REAL_BOT' || p.source.includes('LIVE')) && engineTradeMode === 'real') {
        const closeSide = p.side === 'LONG' ? 'SELL' : 'BUY';
        logEngine(`?? Manual UI Close triggered for LIVE position`, 'warning');

        const reqBody = {
            symbol: p.symbol,
            side: closeSide,
            quantity: p.qty ? parseFloat(p.qty).toFixed(3) : (p.amount / p.entryPrice).toFixed(3),
            type: 'MARKET'
        };
        if (isHedgeMode) reqBody.positionSide = p.side;

        fetch('/api/futures/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody)
        }).then(() => {
            if (typeof fetchOpenOrders === 'function') fetchOpenOrders();
        }).catch(e => logEngine('Manual close failed: ' + e.message, 'error'));
    }

    // Clear bot state if this is a bot-managed position
    if (stBotPosition && stBotPosition.id === id) {
        stBotPosition = null;
        if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = '? Waiting for next signal...';
        document.getElementById('engine-trailing-sl').textContent = '--';
    } else if (stBotHedgePosition && stBotHedgePosition.id === id) {
        stBotHedgePosition = null;
        const hedgeEl = document.getElementById('engine-hedge-signal');
        if (hedgeEl) hedgeEl.style.display = 'none';
        logEngine(`?? Manual UI Close triggered for HEDGE position`, 'warning');
    }

    const isLong = p.side === 'LONG' || p.side === 'BUY';
    const diff = isLong ? lastPrice - p.entryPrice : p.entryPrice - lastPrice;
    const pnl = (p.amount / p.entryPrice) * diff;

    paperBalance += p.margin + pnl;

    // Track in history
    paperTradeHistory.unshift({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        exitPrice: lastPrice,
        amount: p.amount,
        margin: p.margin,
        leverage: p.leverage,
        pnl: pnl,
        pnlPct: (pnl / p.margin) * 100, // leveraged ROI
        closedAt: new Date().toLocaleTimeString([], { hour12: false }),
        reason: pnl >= 0 ? 'TP' : 'SL'
    });
    if (paperTradeHistory.length > 50) paperTradeHistory.pop();

    paperPositions.splice(index, 1);

    showToast(`Closed ${p.side} position for ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} PnL`, pnl >= 0 ? 'success' : 'error');
    renderPaperPositions();
}

// ============================================================
// UI UPDATES
// ============================================================

/**
 * ??? Advanced Trade Management: Profit Lock, Partial TP, ATR Trailing
 * Centralized logic called by every strategy handler.
 */
async function monitorBotTrade(pos, price, klines, strategyName) {
    if (!pos) return;

    const isLong = pos.side === 'LONG' || pos.side === 'BUY';
    const notional = pos.notional || pos.amount || 0;
    if (notional === 0) return;

    const profitUSD = isLong ? (price - pos.entryPrice) * (notional / pos.entryPrice) : (pos.entryPrice - price) * (notional / pos.entryPrice);
    const profitPct = (profitUSD / (pos.margin || 1)) * 100;

    // Debug Pulse (every 10s)
    const now = Date.now();
    if (!pos.lastMonitorLog || now - pos.lastMonitorLog > 10000) {
        pos.lastMonitorLog = now;
        console.log(`[Monitor] ${strategyName} | PnL: $${profitUSD.toFixed(2)} | Target: $${document.getElementById('cfg-profit-lock-val')?.value}`);
    }

    // 1. Profit Lock Floor
    const lockToggle = document.getElementById('cfg-profit-lock-toggle')?.checked;
    const lockFloor = parseFloat(document.getElementById('cfg-profit-lock-val')?.value || '5.0');

    if (lockToggle && profitUSD >= lockFloor && !pos.isProfitLocked) {
        pos.isProfitLocked = true;
        const qty = pos.quantity || pos.qty || (pos.amount / pos.entryPrice);
        // Move SL exactly to the floor price
        const priceOffset = lockFloor / qty;
        pos.trailingSL = isLong ? pos.entryPrice + priceOffset : pos.entryPrice - priceOffset;

        logEngine(`?🔒 [PROFIT LOCK] Floor hit! SL set to ${formatPrice(pos.trailingSL)} (Locking exactly $${lockFloor.toFixed(2)})`, 'success');
    }

    // --- Trailing Stop Loss Management ---
    const trailingAtrMult = parseFloat(document.getElementById('cfg-atr-trail-val')?.value || '0');
    const atrValue = getAtrValue(klines);
    if (trailingAtrMult > 0 && atrValue > 0) {
        const atrDist = atrValue * trailingAtrMult;
        const newTrailingSL = isLong ? price - atrDist : price + atrDist;

        if (pos.trailingSL === undefined || (isLong && newTrailingSL > pos.trailingSL) || (!isLong && newTrailingSL < pos.trailingSL)) {
            pos.trailingSL = newTrailingSL;
            // Only log if it's a significant move or first time
            if (Math.abs(newTrailingSL - (pos._lastLoggedSL || 0)) / pos.entryPrice > 0.001) {
                logEngine(`?📈 [TRAILING] SL Trailed to ${formatPrice(pos.trailingSL)} (${trailingAtrMult}xATR)`, 'info');
                pos._lastLoggedSL = pos.trailingSL;
            }
        }
    }

    // Update Control Center UI if this is the main bot position
    if (stBotPosition && pos.id === stBotPosition.id) {
        const slEl = document.getElementById('engine-trailing-sl');
        const slPnlEl = document.getElementById('engine-sl-pnl');
        if (slEl) slEl.textContent = formatPrice(pos.trailingSL || 0);

        if (slPnlEl && pos.trailingSL && pos.entryPrice && pos.entryPrice > 0) {
            const isLong = pos.side === 'LONG' || pos.side === 'BUY';
            const entry = parseFloat(pos.entryPrice || 0);
            const notional = parseFloat(pos.notional || pos.amount || 0);
            const qty = pos.quantity || pos.qty || (notional / entry);
            const slPnl = isLong ? (pos.trailingSL - entry) * qty : (entry - pos.trailingSL) * qty;

            if (!isNaN(slPnl)) {
                const pnlColor = slPnl >= 0 ? 'var(--up)' : 'var(--down)';
                slPnlEl.style.color = pnlColor;
                // Use higher precision for small amounts
                const pnlStr = Math.abs(slPnl) < 1 ? slPnl.toFixed(4) : slPnl.toFixed(2);
                slPnlEl.textContent = `(${slPnl >= 0 ? '+' : ''}$${pnlStr})`;
            } else {
                slPnlEl.textContent = '';
            }
        } else if (slPnlEl) {
            slPnlEl.textContent = '';
        }
    }

    // 2. Partial TP (50%)
    const partialToggle = document.getElementById('cfg-partial-tp-toggle')?.checked;
    const partialAtrMult = parseFloat(document.getElementById('cfg-partial-tp-val')?.value || '1.5');
    const atr = getAtrValue(klines);

    if (partialToggle && !pos.isPartialClosed && atr > 0) {
        const targetPrice = isLong ? pos.entryPrice + (atr * partialAtrMult) : pos.entryPrice - (atr * partialAtrMult);
        const hitTarget = isLong ? price >= targetPrice : price <= targetPrice;

        if (hitTarget) {
            logEngine(`💰 [PARTIAL TP] Hit ${partialAtrMult}xATR target! Closing 50% position.`, 'success');
            pos.isPartialClosed = true;

            const closeQty = (pos.qty || (pos.amount / pos.entryPrice)) / 2;
            const pnl = (closeQty * (isLong ? price - pos.entryPrice : pos.entryPrice - price));

            if (engineTradeMode === 'real') {
                const body = {
                    symbol: pos.symbol,
                    side: isLong ? 'SELL' : 'BUY',
                    quantity: closeQty.toFixed(3),
                    type: 'MARKET',
                    positionSide: pos.side // pos.side is LONG or SHORT in hedge mode
                };

                fetch('/api/futures/order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                }).catch(e => logEngine(`? Partial TP Order Failed: ${e.message}`, 'error'));
            } else {
                // SIM Mode: Record partial in history
                const currentMargin = pos.margin || (pos.amount / (pos.leverage || 10));
                paperTradeHistory.push({
                    id: Date.now() + '_PARTIAL',
                    symbol: pos.symbol,
                    side: pos.side,
                    leverage: pos.leverage || 10,
                    entryPrice: pos.entryPrice,
                    exitPrice: price,
                    amount: pos.amount / 2,
                    pnl: pnl || 0,
                    pnlPct: currentMargin > 0 ? (pnl / (currentMargin / 2)) * 100 : 0,
                    reason: 'Partial TP (50%)',
                    closedAt: new Date().toLocaleTimeString(),
                    isBot: true
                });
            }

            pos.amount /= 2;
            pos.margin /= 2;
            if (pos.qty) pos.qty /= 2;
        }
    }

    // 3. Stop Loss Hit Check (Profit Lock or Trailing)
    if (pos.trailingSL) {
        const isLong = pos.side === 'LONG' || pos.side === 'BUY';
        const hitSL = isLong ? price <= pos.trailingSL : price >= pos.trailingSL;

        if (hitSL) {
            const reason = pos.isProfitLocked ? 'Profit Lock Hit' : 'Trailing SL Hit';
            logEngine(`🛑 [STOP LOSS] ${reason} @ ${formatPrice(pos.trailingSL)}`, 'warning');

            if (engineTradeMode === 'real') {
                stBotCloseReal(reason);
            } else {
                stBotClosePosition(price, reason);
            }
            return; // Position closed
        }
    }
}

function getAtrValue(klines, period = 14) {
    if (!klines || klines.length < period + 1) return 0;
    let trs = [];
    for (let i = klines.length - period; i < klines.length; i++) {
        const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function updateEstimates() {
    const margin = parseFloat(document.getElementById('order-amount')?.value || 0);
    const leverage = parseInt(document.getElementById('leverage-slider')?.value || 10);
    const notional = margin * leverage;

    const qtyEl = document.getElementById('est-quantity');
    const feeEl = document.getElementById('est-fee');

    if (lastPrice > 0 && margin > 0) {
        const qty = notional / lastPrice;
        const sym = currentSymbol.replace('USDT', '');
        if (qtyEl) qtyEl.textContent = `~${qty.toFixed(6)} ${sym}`;
        if (feeEl) feeEl.textContent = `~$${(notional * 0.001).toFixed(2)}`;
    } else {
        const sym = currentSymbol.replace('USDT', '');
        if (qtyEl) qtyEl.textContent = `-- ${sym}`;
        if (feeEl) feeEl.textContent = '~$0.00';
    }
}

function updateSubmitButton() {
    const btn = document.getElementById('submit-order-btn');
    if (!btn) return;
    const sym = currentSymbol.replace('USDT', '/USDT');
    const actionText = currentSide === 'BUY' ? 'LONG' : 'SHORT';
    btn.textContent = `OPEN ${actionText} ${sym}`;
    btn.className = `order-submit-btn ${currentSide === 'BUY' ? 'buy' : 'sell'}`;
}

// ============================================================
// EVENT LISTENERS
// ============================================================
function initEventListeners() {
    // Symbol select
    document.getElementById('symbol-select')?.addEventListener('change', (e) => {
        switchSymbol(e.target.value);
    });

    // Reset Chart Zoom
    document.getElementById('chart-reset-zoom')?.addEventListener('click', () => {
        if (chart) chart.timeScale().fitContent();
    });

    // Interval buttons
    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.addEventListener('click', () => switchInterval(btn.dataset.interval));
    });

    // Order type tabs (Market/Limit/Stop/Simulation) � use data-type not data-list
    document.querySelectorAll('.order-tab[data-type]').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.order-tab[data-type]').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentOrderType = tab.dataset.type;

            const limitGroup = document.getElementById('limit-price-group');
            const stopGroup = document.getElementById('stop-price-group');
            if (limitGroup) limitGroup.style.display = (currentOrderType === 'limit' || currentOrderType === 'stop') ? 'flex' : 'none';
            if (stopGroup) stopGroup.style.display = currentOrderType === 'stop' ? 'flex' : 'none';
        });
    });

    // Buy/Sell side buttons
    document.getElementById('btn-side-buy')?.addEventListener('click', () => {
        currentSide = 'BUY';
        document.getElementById('btn-side-buy').classList.add('active');
        document.getElementById('btn-side-sell').classList.remove('active');
        updateSubmitButton();
    });

    document.getElementById('btn-side-sell')?.addEventListener('click', () => {
        currentSide = 'SELL';
        document.getElementById('btn-side-sell').classList.add('active');
        document.getElementById('btn-side-buy').classList.remove('active');
        updateSubmitButton();
    });

    // Submit order
    document.getElementById('submit-order-btn')?.addEventListener('click', placeOrder);

    // Cancel all
    document.getElementById('cancel-all-btn')?.addEventListener('click', cancelAllOrders);

    // Amount presets & slider
    const amountInput = document.getElementById('order-amount');
    const orderSlider = document.getElementById('order-slider');

    function setAmountFromPct(pct) {
        const balance = engineTradeMode === 'real' ? (balanceData?.totalUSDT || 0) : (typeof paperBalance !== 'undefined' ? paperBalance : 1000);
        amountInput.value = (balance * (pct / 100)).toFixed(2);
        orderSlider.value = pct;
        updateEstimates();
        updateBetSizeInfo();
    }

    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const pct = parseInt(btn.dataset.pct);
            setAmountFromPct(pct);
        });
    });

    orderSlider?.addEventListener('input', (e) => {
        setAmountFromPct(parseInt(e.target.value));
    });

    amountInput?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) || 0;
        const balance = engineTradeMode === 'real' ? (balanceData?.totalUSDT || 0) : (typeof paperBalance !== 'undefined' ? paperBalance : 1000);
        let pct = balance > 0 ? (val / balance) * 100 : 0;
        if (pct > 100) pct = 100;
        orderSlider.value = pct;
        updateEstimates();
        updateBetSizeInfo();
    });

    // Leverage Slider
    const leverageSlider = document.getElementById('leverage-slider');
    const leverageDisplay = document.getElementById('leverage-display');
    leverageSlider?.addEventListener('input', (e) => {
        leverage = parseInt(e.target.value);
        leverageDisplay.textContent = `${leverage}x`;
        updateEstimates();
        updateBetSizeInfo();
    });

    // Sub-Tabs for Positions, Open Orders, Bot Engine, Backtest (Main Panel)
    document.querySelectorAll('.order-tab[data-list]').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.order-tab[data-list]').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const listType = tab.dataset.list;
            const posCont = document.getElementById('positions-container');
            const ordCont = document.getElementById('open-orders-container');
            const botCont = document.getElementById('bot-engine-container');
            const btCont = document.getElementById('backtest-container');

            if (posCont) posCont.classList.add('hidden');
            if (ordCont) ordCont.classList.add('hidden');
            if (botCont) botCont.classList.add('hidden');
            if (btCont) btCont.classList.add('hidden');

            if (listType === 'positions') {
                if (posCont) posCont.classList.remove('hidden');
                renderPaperPositions();
            } else if (listType === 'orders') {
                if (ordCont) ordCont.classList.remove('hidden');
                fetchOpenOrders();
            } else if (listType === 'bot-engine') {
                if (botCont) botCont.classList.remove('hidden');
            } else if (listType === 'backtest') {
                if (btCont) btCont.classList.remove('hidden');
            }
        });
    });

    // Screener Tabs
    document.querySelectorAll('.scr-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.scr-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeScreenerTab = tab.dataset.tab;
            renderScreenerTable();
        });
    });

    // Screener Search
    document.getElementById('screener-search')?.addEventListener('input', renderScreenerBody);

    // Engine Trade Mode Toggle
    const simBtn = document.getElementById('engine-trade-sim');
    const realBtn = document.getElementById('engine-trade-real');

    const betSizeInput = document.getElementById('cfg-bet-size');
    if (betSizeInput) {
        betSizeInput.addEventListener('input', updateBetSizeInfo);
    }

    simBtn?.addEventListener('click', () => {
        engineTradeMode = 'sim';
        simBtn.classList.add('active');
        simBtn.style.background = 'var(--bg-elevated)';
        simBtn.style.color = 'var(--text-primary)';
        realBtn.classList.remove('active');
        realBtn.style.background = 'transparent';
        realBtn.style.color = 'var(--text-secondary)';
        updateBetSizeInfo();
        renderPaperPositions();
    });

    realBtn?.addEventListener('click', () => {
        // Show custom confirm modal
        const modal = document.getElementById('confirm-modal');
        if (modal) modal.classList.remove('hidden');
    });

    // Custom confirm modal listeners
    document.getElementById('cancel-confirm-btn')?.addEventListener('click', () => {
        document.getElementById('confirm-modal').classList.add('hidden');
    });

    document.getElementById('accept-confirm-btn')?.addEventListener('click', () => {
        document.getElementById('confirm-modal').classList.add('hidden');
        // Apply REAL mode
        engineTradeMode = 'real';
        realBtn.classList.add('active');
        realBtn.style.background = 'var(--bg-elevated)';
        realBtn.style.color = 'var(--text-primary)';
        simBtn.classList.remove('active');
        simBtn.style.background = 'transparent';
        simBtn.style.color = 'var(--text-secondary)';
        showToast('Switched to REAL mode', 'warning');
        updateBetSizeInfo();
        renderPaperPositions();
    });

    // Close real modal on outside click
    document.getElementById('confirm-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.currentTarget.classList.add('hidden');
        }
    });

    // --- Modals ---
    document.getElementById('settings-btn').addEventListener('click', () => {
        document.getElementById('settings-modal').classList.remove('hidden');

        // Populate settings
        document.getElementById('cfg-st-atr').value = botConfig.supertrend.atrPeriod;
        document.getElementById('cfg-st-factor').value = botConfig.supertrend.factor;
        document.getElementById('cfg-sar-start').value = botConfig.parabolicSAR.start;
        document.getElementById('cfg-sar-max').value = botConfig.parabolicSAR.max;
        document.getElementById('cfg-adx-len').value = botConfig.adx.length;
        document.getElementById('cfg-adx-thresh').value = botConfig.adx.threshold;
    });

    document.getElementById('close-settings').addEventListener('click', () => {
        document.getElementById('settings-modal').classList.add('hidden');
    });
    document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);

    // Screener modal
    document.getElementById('screener-btn')?.addEventListener('click', openScreener);

    // Modal overlay close
    document.getElementById('settings-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.currentTarget.classList.add('hidden');
        }
    });

    // Toggle EMA & RSI
    document.getElementById('toggle-ema')?.addEventListener('change', (e) => {
        loadKlines();
    });

    document.getElementById('toggle-rsi')?.addEventListener('change', (e) => {
        loadKlines();
    });

    // Toggle Volume
    document.getElementById('toggle-volume')?.addEventListener('change', (e) => {
        volumeSeries.applyOptions({
            visible: e.target.checked
        });
    });

    // Nav tabs (Trade, Positions, History)
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const tab = btn.dataset.tab;
            const historyPanel = document.getElementById('history-panel');
            const positionsPanel = document.getElementById('positions-panel');

            if (tab === 'history') {
                historyPanel.classList.remove('hidden');
                positionsPanel.classList.add('hidden');
                fetchTradeHistory();
            } else if (tab === 'positions') {
                positionsPanel.classList.remove('hidden');
                historyPanel.classList.add('hidden');
                renderPaperPositions();
            } else {
                historyPanel.classList.add('hidden');
                positionsPanel.classList.add('hidden');
            }
        });
    });

    // Refresh history
    document.getElementById('refresh-history-btn')?.addEventListener('click', fetchTradeHistory);

    // Engine toggle
    document.getElementById('engine-toggle')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            // Reset bot state for fresh start
            stBotLastCandleTime = 0;
            stBotLastDirection = 0;
            vwapMomLastCandleTime = 0;
            macdTrendLastCandleTime = 0;
            bollingerMRLastCandleTime = 0;
            stochVWAPLastCandleTime = 0;
            heikinAshiLastCandleTime = 0;
            const stratName = document.getElementById('engine-mode')?.options[document.getElementById('engine-mode').selectedIndex]?.text || 'Unknown';
            logEngine(`? Bot ACTIVATED | Strategy: ${stratName} | TF: ${tradeInterval}`, 'success');
            logEngine(`?? Config: Bet=$${document.getElementById('cfg-bet-size')?.value || 10}, Lev=${document.getElementById('cfg-engine-leverage')?.value || 10}x, Mode=${engineTradeMode.toUpperCase()}`, 'info');
            showToast(`? ${stratName} Bot ACTIVATED`, 'success');
            // Trigger immediate evaluation for all strategies
            handleSuperTrendBot();
            handleTripleStRsiBot();
            handlePureSuperTrendBot();
            handleVWAPMomentumBot();
            handleMACDTrendBot();
            handleBollingerMeanRevBot();
            handleStochVWAPBot();
            handleHeikinAshiBot();
            handlePureSARBot();
            handlePureRSIBot();
            handlePureEMABot();
            handlePureRsiEmaBot();
            handleStSarAdxBot();
            handleRsiEmaPivotBot();
        } else {
            logEngine('? Bot DEACTIVATED', 'warning');
            showToast('? Bot DEACTIVATED', 'info');
        }
    });

    // --- Simulation Mode UI (opens Backtest tab) ---
    document.getElementById('sim-mode-btn')?.addEventListener('click', () => {
        document.querySelector('[data-list="backtest"]')?.click();
    });

    // Backtest Start
    // Removed obsolete startBacktest listener

    // Indicators instant redraw
    const redrawInds = () => { if (candleData && candleData.length > 0) drawIndicators(candleData); };
    document.getElementById('toggle-ema')?.addEventListener('change', redrawInds);
    document.getElementById('toggle-rsi')?.addEventListener('change', redrawInds);
    document.getElementById('toggle-supertrend')?.addEventListener('change', redrawInds);
    document.getElementById('toggle-vwap')?.addEventListener('change', redrawInds);
    document.getElementById('toggle-sar')?.addEventListener('change', redrawInds);

    // Strategy config panel toggle � show/hide per-strategy configs
    const stratConfigMap = {
        'vwap_momentum': 'cfg-group-vwap',
        'macd_trend': 'cfg-group-macd',
        'bollinger_mr': 'cfg-group-bb',
        'stoch_vwap': 'cfg-group-stoch',
        'heikin_ashi': 'cfg-group-ha',
        'pure_sar': 'cfg-group-sar',
        'pure_rsi': 'cfg-group-pure-rsi',
        'pure_ema': 'cfg-group-pure-ema',
        'pure_rsi_ema': 'cfg-group-pure-rsi-ema',
        'st_sar_adx': 'cfg-group-st-sar-adx',
        'combo_bot': 'cfg-group-combo',
    };
    function updateStrategyConfigPanels() {
        const mode = document.getElementById('engine-mode')?.value;
        // Hide all new strategy config groups
        Object.values(stratConfigMap).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        // Show the selected one
        const activeGroupId = stratConfigMap[mode];
        if (activeGroupId) {
            const el = document.getElementById(activeGroupId);
            if (el) el.style.display = 'block';
        }
    }
    document.getElementById('engine-mode')?.addEventListener('change', updateStrategyConfigPanels);
    updateStrategyConfigPanels(); // initial state
}



async function fetchTradeHistory() {
    try {
        const r = await fetch(`/api/my-trades/${currentSymbol}?limit=50`);
        const data = await r.json();

        if (!Array.isArray(data) || data.length === 0) {
            document.getElementById('trade-history-list').innerHTML = '<div class="empty-state">No trades yet</div>';
            return;
        }

        const header = `<div class="th-row header">
            <span>Time</span>
            <span>Side</span>
            <span>Symbol</span>
            <span>Price</span>
            <span>Qty</span>
            <span>Fee</span>
        </div>`;

        const rows = data.reverse().map(t => {
            const time = new Date(t.time).toLocaleString();
            const side = t.isBuyer ? 'BUY' : 'SELL';
            return `<div class="th-row">
                <span style="color:var(--text-muted)">${time}</span>
                <span style="color: ${t.isBuyer ? 'var(--up)' : 'var(--down)'}; font-weight:700;">${side}</span>
                <span>${t.symbol}</span>
                <span class="mono">${formatPrice(parseFloat(t.price))}</span>
                <span class="mono">${parseFloat(t.qty).toFixed(5)}</span>
                <span class="mono" style="color:var(--text-muted)">${parseFloat(t.commission).toFixed(6)}</span>
            </div>`;
        }).join('');

        document.getElementById('trade-history-list').innerHTML = header + rows;

    } catch (e) {
        console.error('[History] Error:', e);
    }
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ============================================================
// SIMULATION (BACKTEST) ENGINE
// ============================================================
async function startSimulation() {
    if (isSimMode) return;

    const symbol = document.getElementById('sim-symbol').value;
    const interval = document.getElementById('sim-interval').value;
    const rawLimit = parseInt(document.getElementById('sim-candles').value || '500');
    // We add 50 to the limit to have enough historical data to calculate the first EMAs/RSIs
    const limit = rawLimit + 50;

    simStartBalance = parseFloat(document.getElementById('sim-capital').value || '1000');
    simSpeed = parseInt(document.getElementById('sim-speed').value || '50');

    // Reset State
    simBalance = simStartBalance;
    simTrades = [];
    simActiveTrade = null;
    simIndex = 50; // Start at index 50 to have history for indicators

    // Stop live updates
    isSimMode = true;
    if (priceWs) priceWs.close();
    if (klineWs) klineWs.close();

    // Update UI
    document.getElementById('sim-start-btn').disabled = true;
    document.getElementById('sim-stop-btn').disabled = false;
    document.getElementById('sim-trade-log').innerHTML = '';
    document.getElementById('sim-log-count').textContent = '0 trades';
    updateSimStats();

    showToast(`Fetching ${rawLimit} ${interval} candles for ${symbol}...`, 'info');

    try {
        const r = await fetch(`/api/klines/${symbol}?interval=${interval}&limit=${limit}`);
        simData = await r.json();

        if (!Array.isArray(simData) || simData.length < 50) {
            throw new Error('Not enough historical data returned.');
        }

        // Calculate Indicators for the entire dataset upfront
        const closes = simData.map(k => k.close);
        simData.ema9 = calcEMA(closes, 9);
        simData.ema21 = calcEMA(closes, 21);
        simData.rsi14 = calcRSI(closes, 14);

        // Clear chart on symbol switch
        if (candleSeries) safeSetData(candleSeries, []);
        if (volumeSeries) safeSetData(volumeSeries, []);
        if (ema9Line) safeSetData(ema9Line, []);
        if (ema21Line) safeSetData(ema21Line, []);
        if (rsiLine) safeSetData(rsiLine, []);
        supertrendLines.forEach(l => safeSetData(candleSeries, []));
        if (vwapLine) safeSetData(vwapLine, []);
        if (sarLine) safeSetData(sarLine, []);

        // Clear position lines
        if (typeof updateChartPositionLines === 'function') {
            updateChartPositionLines([]); // effectively clears all for this symbol
        }

        const initialData = simData.slice(0, simIndex);
        safeSetData(candleSeries, initialData);
        if (document.getElementById('toggle-ema')?.checked) {
            safeSetData(ema9Line, simData.ema9.slice(0, simIndex).map((v, i) => ({ time: initialData[i].time, value: v })).filter(d => d.value !== null));
            safeSetData(ema21Line, simData.ema21.slice(0, simIndex).map((v, i) => ({ time: initialData[i].time, value: v })).filter(d => d.value !== null));
        }

        showToast('Starting backtest...', 'success');

        if (simSpeed === 0) {
            // Instant mode
            while (simIndex < simData.length) {
                processSimTick();
            }
            stopSimulation();
        } else {
            // Visual mode
            simIntervalId = setInterval(processSimTick, simSpeed);
        }

    } catch (e) {
        showToast(`Simulation Error: ${e.message}`, 'error');
        stopSimulation();
    }
}

function stopSimulation() {
    isSimMode = false;
    clearInterval(simIntervalId);

    document.getElementById('sim-start-btn').disabled = false;
    document.getElementById('sim-stop-btn').disabled = true;

    if (simActiveTrade) {
        // Close out open trade at end price
        closeSimTrade(simData[simIndex - 1]?.close || simActiveTrade.entryPrice, 'Backtest End');
    }

    showToast(`Backtest complete! Total PnL: $${(simBalance - simStartBalance).toFixed(2)}`, 'success');
    updateSimStats();
}

function processSimTick() {
    if (simIndex >= simData.length) {
        stopSimulation();
        return;
    }

    const candle = simData[simIndex];
    const prevCandle = simData[simIndex - 1];

    // 1. Update Chart
    candleSeries.update(candle);
    const emaToggle = document.getElementById('toggle-ema')?.checked;
    if (emaToggle) {
        if (simData.ema9[simIndex] !== null) ema9Line.update({ time: candle.time, value: simData.ema9[simIndex] });
        if (simData.ema21[simIndex] !== null) ema21Line.update({ time: candle.time, value: simData.ema21[simIndex] });
    }

    // Update volume, preserving color logic
    volumeSeries.update({
        time: candle.time,
        value: candle.volume,
        color: candle.close >= candle.open ? '#0ecb8133' : '#f6465d33',
    });

    // Update price display
    updatePriceDisplay(candle.close);

    // 2. Update Progress Bar
    const progressPct = ((simIndex - 50) / (simData.length - 50)) * 100;
    document.getElementById('sim-progress-bar').style.width = `${progressPct}%`;

    // 3. Trade Logic
    const strategy = document.getElementById('sim-strategy').value;
    const tpPct = parseFloat(document.getElementById('sim-tp').value || '1.0') / 100;
    const slPct = parseFloat(document.getElementById('sim-sl').value || '0.5') / 100;

    if (simActiveTrade) {
        // Check for TP / SL
        const currentPnlPct = simActiveTrade.side === 'BUY'
            ? (candle.high - simActiveTrade.entryPrice) / simActiveTrade.entryPrice
            : (simActiveTrade.entryPrice - candle.low) / simActiveTrade.entryPrice;

        const currentLossPct = simActiveTrade.side === 'BUY'
            ? (simActiveTrade.entryPrice - candle.low) / simActiveTrade.entryPrice
            : (candle.high - simActiveTrade.entryPrice) / simActiveTrade.entryPrice;

        if (currentPnlPct >= tpPct) {
            const exitPrice = simActiveTrade.side === 'BUY' ? simActiveTrade.entryPrice * (1 + tpPct) : simActiveTrade.entryPrice * (1 - tpPct);
            closeSimTrade(exitPrice, 'Take Profit');
        } else if (currentLossPct >= slPct) {
            const exitPrice = simActiveTrade.side === 'BUY' ? simActiveTrade.entryPrice * (1 - slPct) : simActiveTrade.entryPrice * (1 + slPct);
            closeSimTrade(exitPrice, 'Stop Loss');
        }
    } else {
        // Check for Entry
        let signal = null;

        if (strategy === 'ema_cross') {
            const prevEma9 = simData.ema9[simIndex - 1];
            const prevEma21 = simData.ema21[simIndex - 1];
            const currEma9 = simData.ema9[simIndex];
            const currEma21 = simData.ema21[simIndex];

            if (prevEma9 <= prevEma21 && currEma9 > currEma21) signal = 'BUY';       // Golden Cross
            else if (prevEma9 >= prevEma21 && currEma9 < currEma21) signal = 'SELL'; // Death Cross
        }
        else if (strategy === 'rsi_reversal') {
            const prevRsi = simData.rsi14[simIndex - 1];
            const currRsi = simData.rsi14[simIndex];
            if (prevRsi <= 30 && currRsi > 30) signal = 'BUY';        // Oversold Reversal
            else if (prevRsi >= 70 && currRsi < 70) signal = 'SELL';  // Overbought Reversal
        }
        else if (strategy === 'breakout') {
            if (candle.close > prevCandle.high) signal = 'BUY';
            else if (candle.close < prevCandle.low) signal = 'SELL';
        }

        if (signal) {
            openSimTrade(signal, candle.close, candle.time);
        }
    }

    simIndex++;
}

function openSimTrade(side, price, time) {
    const betSize = parseFloat(document.getElementById('sim-bet').value || '10');
    if (simBalance < betSize) return; // Not enough capital

    simActiveTrade = {
        side,
        entryPrice: price,
        amount: betSize,
        entryTime: time
    };

    logSimEvent(side, price, 0, 'OPEN');
}

function closeSimTrade(exitPrice, reason) {
    const trade = simActiveTrade;
    const fee = trade.amount * 0.001 * 2; // 0.1% entry + 0.1% exit

    let pnl = 0;
    if (trade.side === 'BUY') {
        pnl = (trade.amount / trade.entryPrice) * (exitPrice - trade.entryPrice) - fee;
    } else {
        pnl = (trade.amount / exitPrice) * (trade.entryPrice - exitPrice) - fee;
    }

    simBalance += pnl;
    simTrades.push({ ...trade, exitPrice, pnl, reason });
    simActiveTrade = null;

    logSimEvent(trade.side === 'BUY' ? 'SELL' : 'BUY', exitPrice, pnl, reason);
    updateSimStats();
}

function logSimEvent(side, price, pnl, text) {
    const logContainer = document.getElementById('sim-trade-log');
    const entry = document.createElement('div');
    entry.className = 'sim-log-entry';

    const isWin = pnl > 0 ? 'win' : (pnl < 0 ? 'loss' : '');
    const pnlPrefix = pnl > 0 ? '+' : '';
    const pnlText = pnl !== 0 ? `${pnlPrefix}$${pnl.toFixed(2)}` : text;

    entry.innerHTML = `
        <span class="sl-side ${side.toLowerCase()}">${side}</span>
        <span style="color:var(--text-muted); font-size:9px;">$${formatPrice(price)}</span>
        <span style="color:var(--text-secondary); text-align:center; font-size:9px;">${text}</span>
        <span class="sl-pnl ${isWin}">${pnlText}</span>
    `;

    logContainer.prepend(entry);
    document.getElementById('sim-log-count').textContent = `${simTrades.length} trades`;
}

function updateSimStats() {
    document.getElementById('sim-final-bal').textContent = `$${simBalance.toFixed(2)}`;

    const totalPnl = simBalance - simStartBalance;
    const pnlEl = document.getElementById('sim-total-pnl');
    pnlEl.textContent = `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;
    pnlEl.style.color = totalPnl >= 0 ? 'var(--up)' : 'var(--down)';

    document.getElementById('sim-trades-count').textContent = simTrades.length;

    if (simTrades.length > 0) {
        const wins = simTrades.filter(t => t.pnl > 0);
        const winRate = (wins.length / simTrades.length) * 100;
        document.getElementById('sim-winrate').textContent = `${winRate.toFixed(1)}%`;

        const grossProfit = wins.reduce((sum, t) => sum + (t.pnl > 0 ? t.pnl : 0), 0);
        const grossLoss = Math.abs(simTrades.reduce((sum, t) => sum + (t.pnl < 0 ? t.pnl : 0), 0));
        const profitFactor = grossLoss === 0 ? grossProfit : grossProfit / grossLoss;
        document.getElementById('sim-profit-factor').textContent = profitFactor.toFixed(2);

        // Calculate Drawdown
        let peak = simStartBalance;
        let maxDd = 0;
        let runningBal = simStartBalance;
        for (let t of simTrades) {
            runningBal += t.pnl;
            if (runningBal > peak) peak = runningBal;
            const dd = (peak - runningBal) / peak * 100;
            if (dd > maxDd) maxDd = dd;
        }
        document.getElementById('sim-max-dd').textContent = `${maxDd.toFixed(2)}%`;
    } else {
        document.getElementById('sim-winrate').textContent = '0%';
        document.getElementById('sim-profit-factor').textContent = '0.00';
        document.getElementById('sim-max-dd').textContent = '0%';
    }
}

// Indicator Math
function calcRSI(prices, period) {
    const rsi = [];
    let avgGain = 0, avgLoss = 0;

    // Init state
    for (let i = 0; i < prices.length; i++) {
        if (i < period) {
            rsi.push(null);
            if (i > 0) {
                const diff = prices[i] - prices[i - 1];
                if (diff >= 0) avgGain += diff;
                else avgLoss -= diff;
            }
        } else if (i === period) {
            avgGain /= period;
            avgLoss /= period;
            let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + rs)));
        } else {
            const diff = prices[i] - prices[i - 1];
            const gain = diff > 0 ? diff : 0;
            const loss = diff < 0 ? -diff : 0;

            // Wilder's Smoothing (RMA)
            avgGain = ((avgGain * (period - 1)) + gain) / period;
            avgLoss = ((avgLoss * (period - 1)) + loss) / period;

            let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + rs)));
        }
    }
    return rsi;
}

function calcEMA(prices, period) {
    const result = [];
    const multiplier = 2 / (period + 1);
    let ema = null;

    for (let i = 0; i < prices.length; i++) {
        if (i < period - 1) {
            result.push(null);
        } else if (i === period - 1) {
            ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
            result.push(ema);
        } else {
            ema = (prices[i] - ema) * multiplier + ema;
            result.push(ema);
        }
    }
    return result;
}

function calcStochastic(prices, kPeriod = 14, dPeriod = 3) {
    const n = prices.length;
    let kArr = new Array(n).fill(null);
    let dArr = new Array(n).fill(null);
    if (n < kPeriod) return { k: kArr, d: dArr };
    for (let i = kPeriod - 1; i < n; i++) {
        const slice = prices.slice(i - kPeriod + 1, i + 1);
        const low = Math.min(...slice);
        const high = Math.max(...slice);
        if (high === low) kArr[i] = 50;
        else kArr[i] = ((prices[i] - low) / (high - low)) * 100;
    }
    for (let i = kPeriod + dPeriod - 2; i < n; i++) {
        const slice = kArr.slice(i - dPeriod + 1, i + 1);
        if (slice.every(v => v !== null)) dArr[i] = slice.reduce((a, b) => a + b, 0) / dPeriod;
    }
    return { k: kArr, d: dArr };
}

function calcStochasticRSI(prices, rsiPeriod = 14, stochPeriod = 14, kLimit = 3, dLimit = 3) {
    const rsi = calcRSI(prices.map(p => ({ close: p })), rsiPeriod);
    const validRsi = rsi.filter(v => v !== null);
    const n = prices.length;
    let kArr = new Array(n).fill(null);
    let dArr = new Array(n).fill(null);
    if (validRsi.length < stochPeriod) return { k: kArr, d: dArr };
    const rsiOffset = n - validRsi.length;
    for (let i = rsiOffset + stochPeriod - 1; i < n; i++) {
        const slice = rsi.slice(i - stochPeriod + 1, i + 1);
        const low = Math.min(...slice);
        const high = Math.max(...slice);
        if (high === low) kArr[i] = 50;
        else kArr[i] = ((rsi[i] - low) / (high - low)) * 100;
    }
    for (let i = rsiOffset + stochPeriod + kLimit - 2; i < n; i++) {
        const slice = kArr.slice(i - kLimit + 1, i + 1);
        if (slice.every(v => v !== null)) kArr[i] = slice.reduce((a, b) => a + b, 0) / kLimit;
    }
    for (let i = rsiOffset + stochPeriod + kLimit + dLimit - 3; i < n; i++) {
        const slice = kArr.slice(i - dLimit + 1, i + 1);
        if (slice.every(v => v !== null)) dArr[i] = slice.reduce((a, b) => a + b, 0) / dLimit;
    }
    return { k: kArr, d: dArr };
}

function calcBollingerBands(prices, period = 20, multiplier = 2) {
    const n = prices.length;
    let middle = new Array(n).fill(null);
    let upper = new Array(n).fill(null);
    let lower = new Array(n).fill(null);
    if (n < period) return { middle, upper, lower };
    for (let i = period - 1; i < n; i++) {
        const slice = prices.slice(i - period + 1, i + 1);
        const avg = slice.reduce((a, b) => a + b, 0) / period;
        const stdDev = Math.sqrt(slice.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / period);
        middle[i] = avg;
        upper[i] = avg + (multiplier * stdDev);
        lower[i] = avg - (multiplier * stdDev);
    }
    return { middle, upper, lower };
}

function calcVWAP(data) {
    let vwap = new Array(data.length).fill(null);
    let cumulativePV = 0;
    let cumulativeVol = 0;
    let lastDate = null;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const date = new Date(d.time * 1000).toDateString();
        if (date !== lastDate) {
            cumulativePV = 0;
            cumulativeVol = 0;
            lastDate = date;
        }
        const typicalPrice = (d.high + d.low + d.close) / 3;
        cumulativePV += typicalPrice * d.volume;
        cumulativeVol += d.volume;
        vwap[i] = cumulativeVol === 0 ? typicalPrice : cumulativePV / cumulativeVol;
    }
    return vwap;
}

function calcHeikinAshi(data) {
    const n = data.length;
    let ha = new Array(n).fill(null);
    if (n === 0) return ha;
    let prevOpen = data[0].open;
    let prevClose = data[0].close;
    for (let i = 0; i < n; i++) {
        const d = data[i];
        const close = (d.open + d.high + d.low + d.close) / 4;
        const open = (prevOpen + prevClose) / 2;
        ha[i] = {
            time: d.time, open, high: Math.max(d.high, open, close), low: Math.min(d.low, open, close), close
        };
        prevOpen = open;
        prevClose = close;
    }
    return ha;
}

function calcMACD(prices, fast = 12, slow = 26, signal = 9) {
    const fastEMA = calcEMA(prices, fast);
    const slowEMA = calcEMA(prices, slow);
    const n = prices.length;
    let macdLine = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (fastEMA[i] !== null && slowEMA[i] !== null) macdLine[i] = fastEMA[i] - slowEMA[i];
    }
    const macdValid = macdLine.filter(v => v !== null);
    const signalLine = new Array(n).fill(null);
    if (macdValid.length >= signal) {
        const sigEMA = calcEMA(macdValid, signal);
        const offset = n - macdValid.length;
        for (let j = 0; j < sigEMA.length; j++) {
            if (sigEMA[j] !== null) signalLine[j + offset] = sigEMA[j];
        }
    }
    let histogram = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (macdLine[i] !== null && signalLine[i] !== null) histogram[i] = macdLine[i] - signalLine[i];
    }
    return { macd: macdLine, signal: signalLine, histogram: histogram };
}

// ============================================================
// NEW INDICATORS � VWAP, Bollinger, MACD, Stoch RSI, OBV, HA
// ============================================================

// VWAP � Volume-Weighted Average Price (intraday reset)
function calcVWAP(data) {
    const result = [];
    let cumTPV = 0; // cumulative (typical price � volume)
    let cumVol = 0;
    let currentDay = -1;

    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        const dayKey = Math.floor(c.time / 86400); // group by UTC day
        if (dayKey !== currentDay) {
            cumTPV = 0;
            cumVol = 0;
            currentDay = dayKey;
        }
        const tp = (c.high + c.low + c.close) / 3;
        const vol = c.volume || 1;
        cumTPV += tp * vol;
        cumVol += vol;
        result.push(cumVol > 0 ? cumTPV / cumVol : tp);
    }
    return result;
}

// Bollinger Bands � SMA � mult � s
function calcBollingerBands(closes, period = 20, mult = 2) {
    const upper = [], middle = [], lower = [], bandwidth = [];
    for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) {
            upper.push(null); middle.push(null); lower.push(null); bandwidth.push(null);
            continue;
        }
        const slice = closes.slice(i - period + 1, i + 1);
        const sma = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period;
        const stdDev = Math.sqrt(variance);
        upper.push(sma + mult * stdDev);
        middle.push(sma);
        lower.push(sma - mult * stdDev);
        bandwidth.push(stdDev * mult * 2 / sma * 100); // BB width %
    }
    return { upper, middle, lower, bandwidth };
}

// MACD � Moving Average Convergence Divergence
function calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const emaFast = calcEMA(closes, fastPeriod);
    const emaSlow = calcEMA(closes, slowPeriod);
    const macdLine = [];
    for (let i = 0; i < closes.length; i++) {
        if (emaFast[i] === null || emaSlow[i] === null) { macdLine.push(null); continue; }
        macdLine.push(emaFast[i] - emaSlow[i]);
    }
    // Signal line = EMA of MACD line (only over non-null values)
    const validMacd = macdLine.filter(v => v !== null);
    const signalEma = calcEMA(validMacd, signalPeriod);
    // Map signal back with proper indexing
    const signalLine = [];
    const histogram = [];
    let validIdx = 0;
    for (let i = 0; i < closes.length; i++) {
        if (macdLine[i] === null) {
            signalLine.push(null);
            histogram.push(null);
        } else {
            const sig = signalEma[validIdx] !== undefined ? signalEma[validIdx] : null;
            signalLine.push(sig);
            histogram.push(sig !== null ? macdLine[i] - sig : null);
            validIdx++;
        }
    }
    return { macd: macdLine, signal: signalLine, histogram };
}

// Stochastic RSI � Stochastic oscillator applied to RSI values
function calcStochasticRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
    const rsiArr = calcRSI(closes, rsiPeriod);
    const rawK = [];
    for (let i = 0; i < rsiArr.length; i++) {
        if (i < rsiPeriod + stochPeriod - 1 || rsiArr[i] === null) { rawK.push(null); continue; }
        const slice = rsiArr.slice(i - stochPeriod + 1, i + 1).filter(v => v !== null);
        if (slice.length < stochPeriod) { rawK.push(null); continue; }
        const minRSI = Math.min(...slice);
        const maxRSI = Math.max(...slice);
        rawK.push(maxRSI === minRSI ? 50 : ((rsiArr[i] - minRSI) / (maxRSI - minRSI)) * 100);
    }
    // Smooth %K with SMA
    const k = [];
    for (let i = 0; i < rawK.length; i++) {
        if (i < kSmooth - 1 || rawK[i] === null) { k.push(null); continue; }
        const slice = rawK.slice(i - kSmooth + 1, i + 1).filter(v => v !== null);
        k.push(slice.length >= kSmooth ? slice.reduce((a, b) => a + b, 0) / slice.length : null);
    }
    // %D = SMA of %K
    const d = [];
    for (let i = 0; i < k.length; i++) {
        if (i < dSmooth - 1 || k[i] === null) { d.push(null); continue; }
        const slice = k.slice(i - dSmooth + 1, i + 1).filter(v => v !== null);
        d.push(slice.length >= dSmooth ? slice.reduce((a, b) => a + b, 0) / slice.length : null);
    }
    return { k, d };
}

// OBV � On-Balance Volume
function calcOBV(data) {
    const obv = [0];
    for (let i = 1; i < data.length; i++) {
        const vol = data[i].volume || 0;
        if (data[i].close > data[i - 1].close) obv.push(obv[i - 1] + vol);
        else if (data[i].close < data[i - 1].close) obv.push(obv[i - 1] - vol);
        else obv.push(obv[i - 1]);
    }
    return obv;
}

// OBV Trend � slope of OBV over N periods
function calcOBVTrend(data, period = 10) {
    const obv = calcOBV(data);
    const trend = [];
    for (let i = 0; i < obv.length; i++) {
        if (i < period) { trend.push(0); continue; }
        trend.push(obv[i] - obv[i - period]);
    }
    return trend;
}

// Heikin Ashi � smoothed candle transformation
function calcHeikinAshi(data) {
    const ha = [];
    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        const prevHA = i > 0 ? ha[i - 1] : { open: c.open, close: c.close };
        const haClose = (c.open + c.high + c.low + c.close) / 4;
        const haOpen = (prevHA.open + prevHA.close) / 2;
        const haHigh = Math.max(c.high, haOpen, haClose);
        const haLow = Math.min(c.low, haOpen, haClose);
        ha.push({
            time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose,
            volume: c.volume,
            isGreen: haClose > haOpen,
            // True trend candle = no opposing wick
            noLowerWick: Math.min(haOpen, haClose) <= haLow + (haHigh - haLow) * 0.01,
            noUpperWick: Math.max(haOpen, haClose) >= haHigh - (haHigh - haLow) * 0.01
        });
    }
    return ha;
}

// Volume Moving Average � for volume surge detection
function calcVolumeMA(data, period = 20) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) { result.push(null); continue; }
        const slice = data.slice(i - period + 1, i + 1);
        result.push(slice.reduce((a, c) => a + (c.volume || 0), 0) / period);
    }
    return result;
}

function calcStochastic(prices, kPeriod = 14, dPeriod = 3) {
    const n = prices.length;
    let kArr = new Array(n).fill(null);
    let dArr = new Array(n).fill(null);
    if (n < kPeriod) return { k: kArr, d: dArr };
    for (let i = kPeriod - 1; i < n; i++) {
        const slice = prices.slice(i - kPeriod + 1, i + 1);
        const low = Math.min(...slice);
        const high = Math.max(...slice);
        if (high === low) kArr[i] = 50;
        else kArr[i] = ((prices[i] - low) / (high - low)) * 100;
    }
    for (let i = kPeriod + dPeriod - 2; i < n; i++) {
        const slice = kArr.slice(i - dPeriod + 1, i + 1);
        if (slice.every(v => v !== null)) dArr[i] = slice.reduce((a, b) => a + b, 0) / dPeriod;
    }
    return { k: kArr, d: dArr };
}

function calcStochasticRSI(prices, rsiPeriod = 14, stochPeriod = 14, kLimit = 3, dLimit = 3) {
    const rsi = calcRSI(prices.map(p => ({ close: p })), rsiPeriod);
    const validRsi = rsi.filter(v => v !== null);
    const n = prices.length;
    let kArr = new Array(n).fill(null);
    let dArr = new Array(n).fill(null);
    if (validRsi.length < stochPeriod) return { k: kArr, d: dArr };
    const rsiOffset = n - validRsi.length;
    for (let i = rsiOffset + stochPeriod - 1; i < n; i++) {
        const slice = rsi.slice(i - stochPeriod + 1, i + 1);
        const low = Math.min(...slice);
        const high = Math.max(...slice);
        if (high === low) kArr[i] = 50;
        else kArr[i] = ((rsi[i] - low) / (high - low)) * 100;
    }
    for (let i = rsiOffset + stochPeriod + kLimit - 2; i < n; i++) {
        const slice = kArr.slice(i - kLimit + 1, i + 1);
        if (slice.every(v => v !== null)) kArr[i] = slice.reduce((a, b) => a + b, 0) / kLimit;
    }
    for (let i = rsiOffset + stochPeriod + kLimit + dLimit - 3; i < n; i++) {
        const slice = kArr.slice(i - dLimit + 1, i + 1);
        if (slice.every(v => v !== null)) dArr[i] = slice.reduce((a, b) => a + b, 0) / dLimit;
    }
    return { k: kArr, d: dArr };
}

function calcBollingerBands(prices, period = 20, multiplier = 2) {
    const n = prices.length;
    let middle = new Array(n).fill(null);
    let upper = new Array(n).fill(null);
    let lower = new Array(n).fill(null);
    if (n < period) return { middle, upper, lower };
    for (let i = period - 1; i < n; i++) {
        const slice = prices.slice(i - period + 1, i + 1);
        const avg = slice.reduce((a, b) => a + b, 0) / period;
        const stdDev = Math.sqrt(slice.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / period);
        middle[i] = avg;
        upper[i] = avg + (multiplier * stdDev);
        lower[i] = avg - (multiplier * stdDev);
    }
    return { middle, upper, lower };
}

function calcVWAP(data) {
    let vwap = new Array(data.length).fill(null);
    let cumulativePV = 0;
    let cumulativeVol = 0;
    let lastDate = null;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const date = new Date(d.time * 1000).toDateString();
        if (date !== lastDate) {
            cumulativePV = 0;
            cumulativeVol = 0;
            lastDate = date;
        }
        const typicalPrice = (d.high + d.low + d.close) / 3;
        cumulativePV += typicalPrice * d.volume;
        cumulativeVol += d.volume;
        vwap[i] = cumulativeVol === 0 ? typicalPrice : cumulativePV / cumulativeVol;
    }
    return vwap;
}

function calcHeikinAshi(data) {
    const n = data.length;
    let ha = new Array(n).fill(null);
    if (n === 0) return ha;
    let prevOpen = data[0].open;
    let prevClose = data[0].close;
    for (let i = 0; i < n; i++) {
        const d = data[i];
        const close = (d.open + d.high + d.low + d.close) / 4;
        const open = (prevOpen + prevClose) / 2;
        ha[i] = {
            time: d.time, open, high: Math.max(d.high, open, close), low: Math.min(d.low, open, close), close
        };
        prevOpen = open;
        prevClose = close;
    }
    return ha;
}

function calcMACD(prices, fast = 12, slow = 26, signal = 9) {
    const fastEMA = calcEMA(prices, fast);
    const slowEMA = calcEMA(prices, slow);
    const n = prices.length;
    let macdLine = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (fastEMA[i] !== null && slowEMA[i] !== null) macdLine[i] = fastEMA[i] - slowEMA[i];
    }
    const macdValid = macdLine.filter(v => v !== null);
    const signalLine = new Array(n).fill(null);
    if (macdValid.length >= signal) {
        const sigEMA = calcEMA(macdValid, signal);
        const offset = n - macdValid.length;
        for (let j = 0; j < sigEMA.length; j++) {
            if (sigEMA[j] !== null) signalLine[j + offset] = sigEMA[j];
        }
    }
    let histogram = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (macdLine[i] !== null && signalLine[i] !== null) histogram[i] = macdLine[i] - signalLine[i];
    }
    return { macd: macdLine, signal: signalLine, histogram: histogram };
}

// ============================================================
// NEW STRATEGY HANDLERS
// ============================================================

// --- Shared: get common bot config values ---
function getCommonBotConfig() {
    return {
        isActive: document.getElementById('engine-toggle')?.checked,
        mode: document.getElementById('engine-mode')?.value,
        betSize: parseFloat(document.getElementById('cfg-bet-size')?.value || '10'),
        leverage: parseInt(document.getElementById('cfg-engine-leverage')?.value || '10'),
    };
}

// ------------------------------------------------------------
// STRATEGY 1: VWAP MOMENTUM SCALPER
// ------------------------------------------------------------
let vwapMomLastCandleTime = 0;

async function handleVWAPMomentumBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'vwap_momentum') return;

        const rsiPeriod = parseInt(document.getElementById('cfg-vwap-rsi-period')?.value || '14');
        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < 50) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (VWAP)... (${n}/50)`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== vwapMomLastCandleTime;
        const closes = effectiveKlines.map(c => c.close);
        const vwap = calcVWAP(effectiveKlines);
        const rsi = calcRSI(closes, rsiPeriod);

        const ci = n - 1;
        const currClose = lastPrice;
        const currVWAP = vwap[ci];
        const currRSI = rsi[ci];

        if (currRSI === null || currVWAP === null) return;

        const signal = (currClose > currVWAP && currRSI > 50) ? 'LONG' : (currClose < currVWAP && currRSI < 50 ? 'SHORT' : null);

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) vwapMomLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'vwap_momentum');

            const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
            if (shouldFlip) {
                logEngine(`? VWAP-MOM ATOMIC FLIP: Signal reversed, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('VWAP-Mom Flip');
                    else stBotClosePosition(lastPrice, 'VWAP-Mom Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) stBotOpenPosition(signal, lastPrice, null);
                    } else {
                        stBotOpenPosition(signal, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'VWAP_MOM';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [VWAP-MOM] Active ${pos.side} | RSI:${currRSI.toFixed(1)} | PnL: $${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | RSI:${currRSI.toFixed(1)} | PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) vwapMomLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? VWAP-MOM ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | RSI=${currRSI.toFixed(1)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'VWAP_MOM';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? VWAP-MOM ERROR: ${err.message}`, 'error');
        console.error('[VWAP-Mom] Analysis error:', err);
    }
}

// ------------------------------------------------------------
// STRATEGY 2: MACD TREND RIDER
// ------------------------------------------------------------
let macdTrendLastCandleTime = 0;

async function handleMACDTrendBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'macd_trend') return;

        const macdFast = parseInt(document.getElementById('cfg-macd-fast')?.value || '12');
        const macdSlow = parseInt(document.getElementById('cfg-macd-slow')?.value || '26');
        const macdSignalP = parseInt(document.getElementById('cfg-macd-signal')?.value || '9');
        const emaBias = parseInt(document.getElementById('cfg-macd-ema-bias')?.value || '50');

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        const minHistory = Math.max(macdSlow + macdSignalP + 5, emaBias + 5);
        if (n < minHistory) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (MACD)... (${n}/${minHistory})`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== macdTrendLastCandleTime;
        const closes = effectiveKlines.map(c => c.close);
        const macd = calcMACD(closes, macdFast, macdSlow, macdSignalP);
        const emaTrend = calcEMA(closes, emaBias);

        const ci = n - 1;
        const currMACD = macd.macd[ci];
        const currSig = macd.signal[ci];
        const currEMA = emaTrend[ci];

        if (currMACD === null || currSig === null) return;

        const signal = (currMACD > currSig) ? 'LONG' : 'SHORT';

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) macdTrendLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'macd_trend');

            const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
            if (shouldFlip) {
                logEngine(`? MACD-TREND ATOMIC FLIP: MACD reversed, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('MACD Trend Flip');
                    else stBotClosePosition(lastPrice, 'MACD Trend Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) stBotOpenPosition(signal, lastPrice, null);
                    } else {
                        stBotOpenPosition(signal, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'MACD_TREND';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [MACD-TREND] Active ${pos.side} | Hist:${macd.histogram[ci].toFixed(4)} | PnL: $${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | Hist:${macd.histogram[ci].toFixed(4)} | PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) macdTrendLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            // Initial Entry filters
            const valid = (signal === 'LONG' && lastPrice > currEMA) || (signal === 'SHORT' && lastPrice < currEMA);
            if (!valid) {
                if (Math.floor(Date.now() / 1000) % 10 === 0) {
                    logEngine(`? MACD Entry filter: Signal ${signal} but price ${lastPrice > currEMA ? '>' : '<'} EMA`, 'info');
                }
                return;
            }

            logEngine(`? MACD-TREND ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | Hist: ${macd.histogram[ci].toFixed(4)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'MACD_TREND';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? MACD-TREND ERROR: ${err.message}`, 'error');
        console.error('[MACD-Trend] Analysis error:', err);
    }
}


// ------------------------------------------------------------
// STRATEGY 3: BOLLINGER MEAN REVERSION
// ------------------------------------------------------------
let bollingerMRLastCandleTime = 0;

async function handleBollingerMeanRevBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'bollinger_mr') return;

        const bbPeriod = parseInt(document.getElementById('cfg-bb-period')?.value || '20');
        const bbMult = parseFloat(document.getElementById('cfg-bb-mult')?.value || '2');
        const rsiOversold = parseInt(document.getElementById('cfg-bb-rsi-low')?.value || '35');
        const rsiOverbought = parseInt(document.getElementById('cfg-bb-rsi-high')?.value || '65');

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < bbPeriod + 5) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (BB-MR)... (${n}/${bbPeriod + 5})`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== bollingerMRLastCandleTime;
        const ci = n - 1;

        const closes = effectiveKlines.map(c => c.close);
        const bb = calcBollingerBands(closes, bbPeriod, bbMult);
        const rsiArr = calcRSI(closes, 14);

        const currLower = bb.lower[ci];
        const currUpper = bb.upper[ci];
        const currRsi = rsiArr[ci];

        if (currLower === null || currUpper === null || currRsi === null) return;

        const isBull = lastPrice <= currLower && currRsi < rsiOversold;
        const isBear = lastPrice >= currUpper && currRsi > rsiOverbought;
        const signal = isBull ? 'LONG' : (isBear ? 'SHORT' : null);

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) bollingerMRLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'bollinger_mr');

            const shouldFlip = (isLong && isBear) || (!isLong && isBull);
            if (shouldFlip) {
                const newSide = isLong ? 'SHORT' : 'LONG';
                logEngine(`? BB-MR ATOMIC FLIP: Reversing to ${newSide}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('BB-MR Flip');
                    else stBotClosePosition(lastPrice, 'BB-MR Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(newSide);
                        if (success) stBotOpenPosition(newSide, lastPrice, null);
                    } else {
                        stBotOpenPosition(newSide, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'BB_MR';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [BB-MR] Active ${pos.side} | RSI:${currRsi.toFixed(1)} PnL:$${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | RSI:${currRsi.toFixed(1)} PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) bollingerMRLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? BB-MR ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | RSI: ${currRsi.toFixed(1)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'BB_MR';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? BB-MR ERROR: ${err.message}`, 'error');
        console.error('[Bollinger MR] Error:', err);
    }
}


// ------------------------------------------------------------
// STRATEGY 4: STOCHASTIC VWAP FUSION
// ------------------------------------------------------------
let stochVWAPLastCandleTime = 0;

async function handleStochVWAPBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'stoch_vwap') return;

        const stochRSIPeriod = parseInt(document.getElementById('cfg-stoch-rsi')?.value || '14');
        const stochPeriod = parseInt(document.getElementById('cfg-stoch-period')?.value || '14');
        const oversold = parseInt(document.getElementById('cfg-stoch-oversold')?.value || '20');
        const overbought = parseInt(document.getElementById('cfg-stoch-overbought')?.value || '80');

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < stochRSIPeriod + stochPeriod + 10) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (Stoch)... (${n}/${stochRSIPeriod + stochPeriod + 10})`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== stochVWAPLastCandleTime;
        const closes = effectiveKlines.map(c => c.close);
        const stoch = calcStochasticRSI(closes, stochRSIPeriod, stochPeriod, 3, 3);
        const vwap = calcVWAP(effectiveKlines);

        const ci = n - 1;
        const currK = stoch.k[ci];
        const currD = stoch.d[ci];
        const currVWAP = vwap[ci];

        if (currK === null || currD === null) return;

        const signal = (currK > currD) ? 'LONG' : 'SHORT';

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) stochVWAPLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'stoch_vwap');

            const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
            if (shouldFlip) {
                logEngine(`? STOCH-VWAP ATOMIC FLIP: Crossover reversed, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('Stoch-VWAP Flip');
                    else stBotClosePosition(lastPrice, 'Stoch-VWAP Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) stBotOpenPosition(signal, lastPrice, null);
                    } else {
                        stBotOpenPosition(signal, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'STOCH_VWAP';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [STOCH-VWAP] Active ${pos.side} | K:${currK.toFixed(1)} D:${currD.toFixed(1)} | PnL: $${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | K:${currK.toFixed(1)} D:${currD.toFixed(1)} | PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) stochVWAPLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            // Initial Entry filters: Oversold for LONG, Overbought for SHORT + VWAP alignment
            const inZone = (signal === 'LONG' && currK < oversold) || (signal === 'SHORT' && currK > overbought);
            const vwapAlign = (signal === 'LONG' && lastPrice >= currVWAP * 0.998) || (signal === 'SHORT' && lastPrice <= currVWAP * 1.002);

            if (!inZone || !vwapAlign) {
                if (Math.floor(Date.now() / 1000) % 15 === 0) {
                    logEngine(`? STOCH Entry filter: Zone:${inZone} VWAP:${vwapAlign} | K:${currK.toFixed(1)}`, 'info');
                }
                return;
            }

            logEngine(`? STOCH-VWAP ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | K:${currK.toFixed(1)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'STOCH_VWAP';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? STOCH-VWAP ERROR: ${err.message}`, 'error');
        console.error('[Stoch-VWAP] Analysis error:', err);
    }
}


// ------------------------------------------------------------
// STRATEGY 5: HEIKIN ASHI TREND SNIPER
// ------------------------------------------------------------
let heikinAshiLastCandleTime = 0;

async function handleHeikinAshiBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'heikin_ashi') return;

        const consecutiveCandles = parseInt(document.getElementById('cfg-ha-consecutive')?.value || '2');

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < 30) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (HA Sniper)... (${n}/30)`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== heikinAshiLastCandleTime;
        const ha = calcHeikinAshi(effectiveKlines);
        const vwap = calcVWAP(effectiveKlines);
        const ci = n - 1;

        const currVWAP = vwap[ci];
        const currHA = ha[ci];

        if (!currHA || !currVWAP) return;

        // Check consecutive HA candles
        let bullCount = 0, bearCount = 0;
        for (let j = 0; j < consecutiveCandles; j++) {
            const idx = ci - j;
            if (idx < 0) break;
            const h = ha[idx];
            if (h.isGreen && h.noLowerWick) bullCount++;
            if (!h.isGreen && h.noUpperWick) bearCount++;
        }

        const isBull = bullCount >= consecutiveCandles && lastPrice > currVWAP;
        const isBear = bearCount >= consecutiveCandles && lastPrice < currVWAP;
        const signal = isBull ? 'LONG' : (isBear ? 'SHORT' : null);

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) heikinAshiLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'heikin_ashi');

            const shouldFlip = (isLong && isBear) || (!isLong && isBull);
            if (shouldFlip) {
                const newSide = isLong ? 'SHORT' : 'LONG';
                logEngine(`? HA-SNIPER ATOMIC FLIP: Reversing to ${newSide}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('HA-Sniper Flip');
                    else stBotClosePosition(lastPrice, 'HA-Sniper Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(newSide);
                        if (success) stBotOpenPosition(newSide, lastPrice, null);
                    } else {
                        stBotOpenPosition(newSide, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'HA_SNIPER';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [HA-SNIPER] Active ${pos.side} | HA:${currHA.isGreen ? '??' : '??'} PnL:$${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | HA:${currHA.isGreen ? '??' : '??'} PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) heikinAshiLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? HA-SNIPER ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'HA_SNIPER';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? HA-SNIPER ERROR: ${err.message}`, 'error');
        console.error('[HA Sniper] Error:', err);
    }
}


// ------------------------------------------------------------
// INDICATOR: PARABOLIC SAR
// ------------------------------------------------------------
function calcParabolicSAR(data, afStart = 0.02, afStep = 0.02, afMax = 0.2) {
    const n = data.length;
    if (n < 2) return { sar: [], direction: [] };

    const sar = new Array(n).fill(null);
    const dir = new Array(n).fill(0); // 1 = bullish (SAR below), -1 = bearish (SAR above)

    // Initialize trend using the first half of the data (up to 50 candles) to allow convergence
    const initLook = Math.min(50, Math.floor(n / 2), 100);
    let bullCount = 0, bearCount = 0;
    for (let k = 1; k < initLook; k++) {
        if (data[k].close > data[k - 1].close) bullCount++;
        else bearCount++;
    }
    let isUpTrend = bullCount >= bearCount;
    let af = afStart;
    let ep = isUpTrend ? data[0].high : data[0].low;
    let sarVal = isUpTrend ? data[0].low : data[0].high;

    sar[0] = sarVal;
    dir[0] = isUpTrend ? 1 : -1;

    for (let i = 1; i < n; i++) {
        const prevSar = sarVal;

        // Calculate new SAR
        sarVal = prevSar + af * (ep - prevSar);

        if (isUpTrend) {
            // SAR must not be above the two previous lows
            if (i >= 2) sarVal = Math.min(sarVal, data[i - 1].low, data[i - 2].low);
            else sarVal = Math.min(sarVal, data[i - 1].low);

            // Check for reversal
            if (data[i].low < sarVal) {
                isUpTrend = false;
                sarVal = ep; // SAR = previous EP
                ep = data[i].low;
                af = afStart;
            } else {
                if (data[i].high > ep) {
                    ep = data[i].high;
                    af = Math.min(af + afStep, afMax);
                }
            }
        } else {
            // SAR must not be below the two previous highs
            if (i >= 2) sarVal = Math.max(sarVal, data[i - 1].high, data[i - 2].high);
            else sarVal = Math.max(sarVal, data[i - 1].high);

            // Check for reversal
            if (data[i].high > sarVal) {
                isUpTrend = true;
                sarVal = ep; // SAR = previous EP
                ep = data[i].high;
                af = afStart;
            } else {
                if (data[i].low < ep) {
                    ep = data[i].low;
                    af = Math.min(af + afStep, afMax);
                }
            }
        }

        sar[i] = sarVal;
        dir[i] = isUpTrend ? 1 : -1;
    }

    return { sar, direction: dir };
}

// ------------------------------------------------------------
// SMART SUPPORT/RESISTANCE FILTER (PRICE ACTION)
// ------------------------------------------------------------
function checkSmartSRFilter(signal, data, ci, atr, lastPrice, botName, lookback = 20) {
    if (!signal || ci < lookback) return signal;

    // Find the highest high and lowest low over the lookback period, EXCLUDING the current candle
    // This allows us to detect historic swing points and prevents blocking legitimate breakouts
    let maxH = -Infinity;
    let minL = Infinity;
    for (let i = Math.max(0, ci - lookback); i <= ci - 1; i++) {
        if (data[i].high > maxH) maxH = data[i].high;
        if (data[i].low < minL) minL = data[i].low;
    }

    // Define the "danger zone" as 1 ATR from the extreme
    const buffer = atr * 1.0;

    if (signal === 'LONG') {
        // Condition: Price is BELOW resistance (hasn't broken out), but dangerously CLOSE to it
        if (lastPrice < maxH && (maxH - lastPrice) < buffer) {
            if (Math.floor(Date.now() / 1000) % 3 === 0) {
                logEngine(`?? [${botName}] LONG blocked: Price action near Resistance (${formatPrice(maxH)})`, 'warning');
            }
            return null; // Block entry
        }
    } else if (signal === 'SHORT') {
        // Condition: Price is ABOVE support (hasn't broken down), but dangerously CLOSE to it
        if (lastPrice > minL && (lastPrice - minL) < buffer) {
            if (Math.floor(Date.now() / 1000) % 3 === 0) {
                logEngine(`?? [${botName}] SHORT blocked: Price action near Support (${formatPrice(minL)})`, 'warning');
            }
            return null; // Block entry
        }
    }

    return signal;
}

// ------------------------------------------------------------
// STRATEGY: PURE PARABOLIC SAR
// ------------------------------------------------------------
let pureSARLastCandleTime = 0;

async function handlePureSARBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'pure_sar') return;

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const afStart = parseLocaleFloat(document.getElementById('cfg-sar-af-start')?.value, 0.02);
        const afStep = parseLocaleFloat(document.getElementById('cfg-sar-af-step')?.value, 0.02);
        const afMax = parseLocaleFloat(document.getElementById('cfg-sar-af-max')?.value, 0.2);

        const n = effectiveKlines.length;
        if (n < 50) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (Pure SAR)... (${n}/50)`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== pureSARLastCandleTime;
        const psar = calcParabolicSAR(effectiveKlines, afStart, afStep, afMax);
        const ci = n - 1;

        const currDir = psar.direction[ci]; // 1 = bullish, -1 = bearish
        const currSarValue = psar.sar[ci];

        if (currDir === 0 || currSarValue === null) return;

        const signal = (currDir === 1) ? 'LONG' : 'SHORT';

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) pureSARLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'pure_sar');

            const shouldFlip = (isLong && currDir === -1) || (!isLong && currDir === 1);
            if (shouldFlip) {
                const newSide = isLong ? 'SHORT' : 'LONG';
                logEngine(`? PURE-SAR ATOMIC FLIP: Reversing to ${newSide}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('Pure SAR Flip');
                    else stBotClosePosition(lastPrice, 'Pure SAR Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(newSide);
                        if (success) stBotOpenPosition(newSide, lastPrice, null);
                    } else {
                        stBotOpenPosition(newSide, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'PURE_SAR';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [PURE-SAR] Active ${pos.side} | SAR:${formatPrice(currSarValue)} PnL:$${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | SAR:${formatPrice(currSarValue)} PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) pureSARLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? PURE-SAR ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | SAR: ${formatPrice(currSarValue)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'PURE_SAR';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? PURE-SAR ERROR: ${err.message}`, 'error');
        console.error('[Pure SAR] Error:', err);
    }
}



// ------------------------------------------------------------
// STRATEGY: PURE RSI
// ------------------------------------------------------------
let pureRSILastCandleTime = 0;

async function handlePureRSIBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'pure_rsi') return;

        const period = parseInt(document.getElementById('cfg-prsi-period')?.value || '14');
        const ob = parseFloat(document.getElementById('cfg-prsi-ob')?.value || '70');
        const os = parseFloat(document.getElementById('cfg-prsi-os')?.value || '30');

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < period + 5) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (Pure RSI)... (${n}/${period + 5})`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== pureRSILastCandleTime;
        const ci = n - 1;

        const rsiArr = calcRSI(effectiveKlines.map(c => c.close), period);
        const currRsi = rsiArr[ci];
        if (currRsi === null) return;

        const signal = currRsi > 50 ? 'LONG' : 'SHORT';

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) pureRSILastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'pure_rsi');

            const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
            if (shouldFlip) {
                logEngine(`? PURE-RSI ATOMIC FLIP: RSI crossed 50, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('Pure RSI Flip');
                    else stBotClosePosition(lastPrice, 'Pure RSI Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) stBotOpenPosition(signal, lastPrice, null);
                    } else {
                        stBotOpenPosition(signal, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'PURE_RSI';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [PURE-RSI] Active ${pos.side} | RSI:${currRsi.toFixed(1)} | PnL: $${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | RSI:${currRsi.toFixed(1)} | PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) pureRSILastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            // Initial Entry filters: Use OB/OS for safer first entry if desired?
            // User requested "Always-In", so we just enter based on 50.
            logEngine(`? PURE-RSI ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | RSI: ${currRsi.toFixed(1)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'PURE_RSI';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? PURE-RSI ERROR: ${err.message}`, 'error');
        console.error('[Pure RSI] Error:', err);
    }
}


// ------------------------------------------------------------
// STRATEGY: PURE EMA
// ------------------------------------------------------------
let pureEMALastCandleTime = 0;

async function handlePureEMABot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'pure_ema') return;

        const fastP = parseInt(document.getElementById('cfg-pema-fast')?.value || '9');
        const slowP = parseInt(document.getElementById('cfg-pema-slow')?.value || '21');

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < slowP + 5) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (Pure EMA)... (${n}/${slowP + 5})`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== pureEMALastCandleTime;
        const ci = n - 1;

        const closes = effectiveKlines.map(c => c.close);
        const emaFast = calcEMA(closes, fastP);
        const emaSlow = calcEMA(closes, slowP);
        const currF = emaFast[ci];
        const currS = emaSlow[ci];

        if (currF === null || currS === null) return;

        const signal = currF > currS ? 'LONG' : 'SHORT';

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) pureEMALastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'pure_ema');

            const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
            if (shouldFlip) {
                logEngine(`? PURE-EMA ATOMIC FLIP: Crossover reversed, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('Pure EMA Flip');
                    else stBotClosePosition(lastPrice, 'Pure EMA Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) stBotOpenPosition(signal, lastPrice, null);
                    } else {
                        stBotOpenPosition(signal, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'PURE_EMA';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [PURE-EMA] Active ${pos.side} | F:${currF.toFixed(1)} S:${currS.toFixed(1)} | PnL: $${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | F:${currF.toFixed(1)} S:${currS.toFixed(1)} | PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) pureEMALastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? PURE-EMA ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | Fast:${currF.toFixed(1)} Slow:${currS.toFixed(1)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'PURE_EMA';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? PURE-EMA ERROR: ${err.message}`, 'error');
        console.error('[Pure EMA] Error:', err);
    }
}



// ------------------------------------------------------------
// STRATEGY: PURE RSI + EMA
// ------------------------------------------------------------
let pureRsiEmaLastCandleTime = 0;

async function handlePureRsiEmaBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'pure_rsi_ema') return;

        const fastP = parseInt(document.getElementById('cfg-pre-fast')?.value || '9');
        const slowP = parseInt(document.getElementById('cfg-pre-slow')?.value || '21');
        const rsiP = parseInt(document.getElementById('cfg-pre-rsi-period')?.value || '14');

        const maxP = Math.max(slowP, rsiP);
        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < maxP + 5) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (Pure RSI+EMA)... (${n}/${maxP + 5})`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== pureRsiEmaLastCandleTime;
        const ci = n - 1;

        const closes = effectiveKlines.map(c => c.close);
        const emaFast = calcEMA(closes, fastP);
        const emaSlow = calcEMA(closes, slowP);
        const rsiArr = calcRSI(closes, rsiP);

        const currF = emaFast[ci];
        const currS = emaSlow[ci];
        const currRsi = rsiArr[ci];

        if (currF === null || currS === null || currRsi === null) return;

        const isBull = currRsi > 50 && currF > currS;
        const isBear = currRsi < 50 && currF < currS;
        const signal = isBull ? 'LONG' : (isBear ? 'SHORT' : null);

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) pureRsiEmaLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'pure_rsi_ema');

            const shouldFlip = (isLong && isBear) || (!isLong && isBull);
            if (shouldFlip) {
                const newSide = isLong ? 'SHORT' : 'LONG';
                logEngine(`? PURE-RSI-EMA ATOMIC FLIP: Logic reversed, reversing to ${newSide}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('Pure RSI+EMA Flip');
                    else stBotClosePosition(lastPrice, 'Pure RSI+EMA Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(newSide);
                        if (success) stBotOpenPosition(newSide, lastPrice, null);
                    } else {
                        stBotOpenPosition(newSide, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'PURE_RSI_EMA';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [PURE-RE] Active ${pos.side} | RSI:${currRsi.toFixed(1)} PnL:$${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | RSI:${currRsi.toFixed(1)} PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) pureRsiEmaLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? PURE-RSI-EMA ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | RSI: ${currRsi.toFixed(1)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'PURE_RSI_EMA';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? PURE-RSI-EMA ERROR: ${err.message}`, 'error');
        console.error('[Pure RSI+EMA] Error:', err);
    }
}


// ============================================================
// ADVANCED MARKET SCREENER (Consolidated)
// ============================================================
let isScreenerOpen = false;
let screenerAbortController = null;
let activeScreenerTab = 'scr-price';
let cachedScreenerData = [];
let screenerSort = { key: 'vol', dir: 'desc' };

function openScreener() {
    isScreenerOpen = true;
    document.getElementById('screener-modal')?.classList.remove('hidden');
    renderScreenerTable();
}



function closeScreener() {
    isScreenerOpen = false;
    document.getElementById('screener-modal')?.classList.add('hidden');
    stopRecommendedTrades(); // Kill any active SSE scan
}


function stopRecommendedTrades() {
    if (screenerAbortController) {
        screenerAbortController.abort();
        screenerAbortController = null;
        console.log("?? Recommended Trades scan aborted.");
    }
}

async function renderScreenerTable() {
    if (!isScreenerOpen) return;
    console.log("[Screener] renderScreenerTable start");
    try {
        const btn = document.querySelector('.btn-refresh-scr');
        if (btn) btn.style.opacity = '0.5';

        const r = await fetch('/api/screener-data');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        cachedScreenerData = await r.json();
        console.log(`[Screener] Data fetched: ${cachedScreenerData.length} items`);
        if (cachedScreenerData.length > 0) {
            console.log("[Screener] Sample item:", JSON.stringify(cachedScreenerData[0]));
        } else {
            console.warn("[Screener] API returned EMPTY array!");
        }

        if (btn) btn.style.opacity = '1';

        sortScreenerData();
        renderScreenerHeaders();
        renderScreenerBody();
    } catch (e) {
        console.error("[Screener] Error:", e);
        if (e.name !== 'AbortError') showToast(`Screener error: ${e.message}`, 'error');
    }
}

function sortScreener(key) {
    if (screenerSort.key === key) {
        screenerSort.dir = screenerSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        screenerSort.key = key;
        screenerSort.dir = 'desc';
    }
    sortScreenerData();
    renderScreenerHeaders();
    renderScreenerBody();
}

function sortScreenerData() {
    const key = screenerSort.key;
    const dir = screenerSort.dir === 'asc' ? 1 : -1;
    console.log(`[ScreenerSort] Sorting ${cachedScreenerData.length} items by ${key} ${screenerSort.dir}`);

    // Use spread to ensure we are sorting a fresh reference if needed
    const dataToSort = [...cachedScreenerData];

    dataToSort.sort((a, b) => {
        let valA, valB;
        if (key === 'vol') {
            valA = parseFloat(a.quoteVolume || 0);
            valB = parseFloat(b.quoteVolume || 0);
        } else if (key === 'price') {
            valA = parseFloat(a.price || 0);
            valB = parseFloat(b.price || 0);
        } else if (key === 'change') {
            valA = parseFloat(a.changePercent || 0);
            valB = parseFloat(b.changePercent || 0);
        } else if (key === 'symbol') {
            valA = a.symbol;
            valB = b.symbol;
            return valA.localeCompare(valB) * dir;
        } else if (key === 'funding') {
            valA = parseFloat(a.fundingRate || 0);
            valB = parseFloat(b.fundingRate || 0);
        } else if (key === 'oi') {
            valA = (parseFloat(a.markPrice || a.price) * parseFloat(a.quoteVolume || 0));
            valB = (parseFloat(b.markPrice || b.price) * parseFloat(b.quoteVolume || 0));
        } else {
            return 0;
        }
        if (valA === valB) return 0;
        return (valA > valB ? 1 : -1) * dir;
    });

    cachedScreenerData = dataToSort;
}

function renderScreenerHeaders() {
    const isRec = activeScreenerTab === 'scr-rectrade';
    const recView = document.getElementById('screener-rectrade-view');
    const tabView = document.getElementById('screener-table-view');
    const standardToolbar = document.querySelector('.screener-toolbar');

    if (recView) recView.style.display = isRec ? 'flex' : 'none';
    if (tabView) tabView.style.display = isRec ? 'none' : 'block';
    if (standardToolbar) standardToolbar.style.display = isRec ? 'none' : 'flex';

    if (isRec) return;

    const thead = document.getElementById('screener-t-head');
    if (!thead) return;

    const key = screenerSort.key;
    const dir = screenerSort.dir;
    const arrow = (k) => key === k ? (dir === 'desc' ? ' ?' : ' ?') : ' <span style="opacity:0.3">?</span>';
    const th = (label, k) => `<th style="cursor:pointer;user-select:none;padding:8px 12px;white-space:nowrap;background:#1e2026;border-bottom:1px solid var(--border);" onclick="sortScreener('${k}')">${label}${arrow(k)}</th>`;

    let html = th('Symbol', 'symbol');
    if (activeScreenerTab === 'scr-price') {
        html += th('Price', 'price') + th('24h Chg', 'change') + th('Vol(USDT)', 'vol') + th('Vol(Asset)', 'volAsset') + th('MCap', 'mcap');
    } else if (activeScreenerTab === 'scr-oi') {
        html += th('OI(USDT)', 'oi') + th('OI/MCap', 'oiMcap') + th('Funding', 'funding') + th('Pred. Shift', 'fundShift');
    } else if (activeScreenerTab === 'scr-liq') {
        html += th('Long Liq.', 'liqLong') + th('Short Liq.', 'liqShort') + th('Est.Liq Vol', 'estLiq');
    } else if (activeScreenerTab === 'scr-ls') {
        html += th('L/S Ratio', 'lsRatio') + th('Bias', 'lsBias') + th('Smart $', 'smart');
    } else if (activeScreenerTab === 'scr-onchain') {
        html += th('Ex.Inflow', 'inflow') + th('Ex.Outflow', 'outflow') + th('Basis', 'basis');
    } else if (activeScreenerTab === 'scr-rev') {
        html += th('24h Fees', 'fees') + th('Ann.Rev', 'feesAnn') + th('P/F', 'pfRatio');
    }
    thead.innerHTML = html;
}


function renderScreenerBody() {
    try {
        if (activeScreenerTab === 'scr-rectrade') {
            generateRecommendedTrades();
            return;
        }

        const tbody = document.getElementById('screener-t-body');
        if (!tbody) return;

        console.log(`[Screener] Rendering body. Tab: ${activeScreenerTab}, Search: "${document.getElementById('screener-search')?.value}", Data Size: ${cachedScreenerData?.length || 0}`);

        const searchInput = document.getElementById('screener-search');
        const q = (searchInput?.value || '').toLowerCase();

        const volFilter = document.getElementById('screener-vol-filter');
        const minVol = parseFloat(volFilter?.value || 0);

        const cFilter = document.getElementById('screener-change-filter');
        const changeFilter = cFilter?.value || 'all';

        if (!cachedScreenerData || !Array.isArray(cachedScreenerData) || cachedScreenerData.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-secondary);">
                <div style="margin-bottom:12px;font-size:24px;opacity:0.3;">??</div>
                Waiting for market data...<br>
                <span style="font-size:10px;opacity:0.5;">Ensure server.py is running and WebSocket connection is active.</span>
            </td></tr>`;
            return;
        }

        let rows = cachedScreenerData.filter(d => {
            if (!d || !d.symbol) return false;
            if (q && !d.symbol.toLowerCase().includes(q)) return false;

            const v = parseFloat(d.quoteVolume || 0);
            if (minVol && v < minVol) return false;

            const c = parseFloat(d.changePercent || 0);
            if (changeFilter === 'gainers' && c <= 0) return false;
            if (changeFilter === 'losers' && c >= 0) return false;
            if (changeFilter === 'big' && Math.abs(c) < 5) return false;
            return true;
        });

        let html = '';
        rows.forEach(d => {
            const pColor = d.changePercent >= 0 ? 'var(--up)' : 'var(--down)';
            const fund = parseFloat(d.fundingRate || 0) * 100;
            const fundColor = fund >= 0 ? 'var(--brand)' : 'var(--down)';
            const mark = d.markPrice || d.price || 0;

            // MATH PROXIES
            const oiValue = (parseFloat(mark) * parseFloat(d.quoteVolume || 0)) * 0.1;
            const effectiveOI = (fund !== 0) ? (oiValue * 1.5) : oiValue;
            const mcapProxy = effectiveOI * 15;
            const fees24h = d.quoteVolume * 0.0004;
            const feesAnn = fees24h * 365;
            const pfRatio = mcapProxy / (feesAnn || 1);
            const lsRatio = (fund > 0.01) ? 1.8 + (fund * 10) : (fund < 0) ? Math.max(0.5, 1.0 + (fund * 20)) : 1.1;
            const lsBias = lsRatio > 1.2 ? 'LONG HEAVY' : lsRatio < 0.9 ? 'SHORT HEAVY' : 'NEUTRAL';
            const smartMoney = lsRatio > 1.2 ? 'Short Accum.' : lsRatio < 0.9 ? 'Long Accum.' : 'Ranging';

            html += `<tr onclick="switchSymbol('${d.symbol}'); closeScreener();" style="cursor:pointer;">`;
            html += `<td style="padding:5px 10px;"><span style="font-weight:600;font-family:var(--mono);">${d.symbol.replace('USDT', '')}</span> <span style="font-size:8px;border:1px solid var(--border);padding:1px 3px;border-radius:2px;color:var(--text-secondary);">PERP</span></td>`;

            if (activeScreenerTab === 'scr-price') {
                html += `<td style="font-family:var(--mono)">${formatPrice(d.price)}</td>
                    <td style="color:${pColor}; font-family:var(--mono); font-weight:600;">${d.changePercent >= 0 ? '+' : ''}${d.changePercent.toFixed(2)}%</td>
                    <td style="font-family:var(--mono)">$${formatNumber(d.quoteVolume)}</td>
                    <td style="font-family:var(--mono); color:var(--text-secondary)">${formatNumber(d.volume)}</td>
                    <td style="font-family:var(--mono); color:var(--text-secondary)">$${formatNumber(mcapProxy)}</td>`;
            } else if (activeScreenerTab === 'scr-oi') {
                html += `<td style="font-family:var(--mono)">$${formatNumber(effectiveOI)}</td>
                    <td style="font-family:var(--mono); color:var(--text-secondary)">6.6%</td>
                    <td style="color:${fundColor}; font-family:var(--mono); font-weight:600;">${fund.toFixed(4)}%</td>
                    <td style="font-family:var(--mono); color:var(--text-secondary)">${(fund * 0.8).toFixed(4)}%</td>`;
            } else if (activeScreenerTab === 'scr-liq') {
                html += `<td style="font-family:var(--mono); color:var(--down)">$${formatPrice(d.price * 0.95)}</td>
                    <td style="font-family:var(--mono); color:var(--up)">$${formatPrice(d.price * 1.05)}</td>
                    <td style="font-family:var(--mono)">$${formatNumber(d.quoteVolume * 0.025)}</td>`;
            } else if (activeScreenerTab === 'scr-ls') {
                html += `<td style="font-family:var(--mono); color:${lsRatio > 1 ? 'var(--up)' : 'var(--down)'}; font-weight:600;">${lsRatio.toFixed(2)}</td>
                    <td style="font-size:10px; color:var(--text-secondary);">${lsBias}</td>
                    <td style="font-size:10px; color:var(--text-secondary);">${smartMoney}</td>`;
            } else if (activeScreenerTab === 'scr-onchain') {
                const basis = ((d.price - mark) / d.price) * 100;
                html += `<td style="font-family:var(--mono); color:var(--down)">$${formatNumber(d.quoteVolume * 0.12)}</td>
                    <td style="font-family:var(--mono); color:var(--up)">$${formatNumber(d.quoteVolume * 0.11)}</td>
                    <td style="font-family:var(--mono); color:${basis > 0 ? 'var(--up)' : 'var(--down)'}">${basis.toFixed(3)}%</td>`;
            } else if (activeScreenerTab === 'scr-rev') {
                html += `<td style="font-family:var(--mono); color:var(--brand)">$${formatNumber(fees24h)}</td>
                    <td style="font-family:var(--mono)">$${formatNumber(feesAnn)}</td>
                    <td style="font-family:var(--mono); color:var(--text-secondary)">${pfRatio.toFixed(1)}x</td>`;
            }
            html += `</tr>`;
        });

        if (!html) html = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-secondary);">No results</td></tr>`;
        tbody.innerHTML = html;
    } catch (err) {
        console.error("[Screener] renderScreenerBody error:", err);
    }
}


// ------------------------------------------------------------
// STRATEGY: SUPERTREND + SAR + ADX
// ------------------------------------------------------------
let stSarAdxLastCandleTime = 0;

async function handleStSarAdxBot() {
    isEngineActive = document.getElementById('engine-toggle')?.checked;
    if (!isEngineActive) return;
    if (isStBotBusy) return;

    const mode = document.getElementById('engine-mode')?.value;
    if (mode !== 'st_sar_adx') return;

    const effectiveKlines = candleCache[tradeIntervalSecs] || [];
    const n = effectiveKlines.length;
    if (n < 30) {
        if (Math.floor(Date.now() / 1000) % 10 === 0) {
            logEngine(`? Waiting for ${tradeInterval} data (ST-SAR-ADX)...`, 'warning');
            fetchBackgroundTradeKlines();
        }
        return;
    }

    const adxThresh = parseLocaleFloat(document.getElementById('cfg-st-sar-adx-trend')?.value, 25);
    const stPeriod = parseInt(document.getElementById('cfg-st-period')?.value || '10');
    const stMult = parseLocaleFloat(document.getElementById('cfg-st-multiplier')?.value, 3);
    const afStart = parseLocaleFloat(document.getElementById('cfg-st-sar-af-start')?.value, 0.02);
    const afStep = parseLocaleFloat(document.getElementById('cfg-st-sar-af-step')?.value, 0.02);
    const afMax = parseLocaleFloat(document.getElementById('cfg-st-sar-af-max')?.value, 0.2);

    const latestCandleTime = effectiveKlines[n - 1].time;
    const isNewCandle = latestCandleTime !== stSarAdxLastCandleTime;

    const psar = calcParabolicSAR(effectiveKlines, afStart, afStep, afMax);
    const stResult = calcSupertrendRaw(effectiveKlines, stPeriod, stMult);
    const adxResult = calcADX(effectiveKlines, 14);

    if (!adxResult || !psar || !stResult || stResult.length === 0) return;

    const ci = n - 1;
    const currSarDir = psar.direction[ci]; // 1 = bullish, -1 = bearish
    const currStDir = stResult.direction[ci]; // 1 = bullish, -1 = bearish
    const currAdx = adxResult.adx;

    const signal = (currStDir === 1 && currSarDir === 1) ? 'LONG' : (currStDir === -1 && currSarDir === -1 ? 'SHORT' : null);

    // --- IF IN POSITION: ATOMIC FLIP ---
    if (stBotPosition) {
        if (isNewCandle) stSarAdxLastCandleTime = latestCandleTime;
        const pos = stBotPosition;
        const isLong = pos.side === 'LONG';
        const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

        // Monitoring & Advanced Trade Management
        monitorBotTrade(pos, lastPrice, effectiveKlines, 'st_sar_adx');

        const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
        if (shouldFlip) {
            logEngine(`? ST-SAR-ADX ATOMIC FLIP: Reversing to ${signal}...`, 'warning');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') await stBotCloseReal('ST-SAR-ADX Flip');
                else stBotClosePosition(lastPrice, 'ST-SAR-ADX Flip');

                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'ST_SAR_ADX';
            } finally { isStBotBusy = false; }
            return;
        }

        if (Math.floor(Date.now() / 1000) % 15 === 0) {
            logEngine(`📊 [ST-SAR-ADX] Active ${pos.side} | ADX:${currAdx.toFixed(1)} PnL:$${pnlUSD.toFixed(2)}`, 'info');
        }
        if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | ADX:${currAdx.toFixed(1)} PnL:$${pnlUSD.toFixed(2)}`;
        return;
    }

    if (isNewCandle) stSarAdxLastCandleTime = latestCandleTime;

    // --- NO POSITION: Entry ---
    if (signal) {
        if (currAdx < adxThresh) {
            if (Math.floor(Date.now() / 1000) % 15 === 0)
                logEngine(`? ST-SAR-ADX: Signal ${signal} but ADX ${currAdx.toFixed(1)} below ${adxThresh}`, 'info');
            return;
        }

        logEngine(`? ST-SAR-ADX ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | ADX=${currAdx.toFixed(1)}`, 'success');
        isStBotBusy = true;
        try {
            if (engineTradeMode === 'real') {
                const success = await stBotOpenReal(signal);
                if (success) stBotOpenPosition(signal, lastPrice, null);
            } else {
                stBotOpenPosition(signal, lastPrice, null);
            }
            if (stBotPosition) stBotPosition.source = 'ST_SAR_ADX';
        } finally { isStBotBusy = false; }
    }
}

// ============================================================
// STRATEGY: RSI + EMA + PIVOT POINTS
// ============================================================
let rsiEmaPivotLastCandleTime = 0;

async function handleRsiEmaPivotBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'rsi_ema_pivot') return;

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < 50) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (RSI-EMA-PIVOT)...`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== rsiEmaPivotLastCandleTime;

        // --- CALC INDICATORS ---
        const closes = effectiveKlines.map(c => c.close);
        const ema20Arr = calcEMA(closes, 20);
        const ema50Arr = calcEMA(closes, 50);
        const rsiArr = calcRSI(closes, 14);

        const ci = n - 1;
        if (ci < 1) return;

        const isSyntheticTrade = tradeIntervalSecs < 60 || SYNTHETIC_INTERVALS.includes(tradeInterval);
        const evalIdx = isSyntheticTrade ? ci : ci - 1;
        if (evalIdx < 0) return;

        const currE20 = ema20Arr[evalIdx];
        const currE50 = ema50Arr[evalIdx];
        const currRSI = rsiArr[evalIdx];
        const closePx = effectiveKlines[ci].close;

        if (currE20 === null || currE50 === null || currRSI === null) return;

        // --- ROLLING PIVOT CALC ---
        const lookbackMap = { '1m': 1440, '2m': 720, '3m': 480, '5m': 288, '15m': 96, '1h': 24 };
        const lb = lookbackMap[tradeInterval] || 24;
        const startIdx = Math.max(0, ci - lb);
        const rangeKlines = effectiveKlines.slice(startIdx, ci + 1);
        const pHigh = Math.max(...rangeKlines.map(k => k.high));
        const pLow = Math.min(...rangeKlines.map(k => k.low));
        const P = (pHigh + pLow + closePx) / 3;

        // --- ENHANCED SIGNAL LOGIC (Faster Flips) ---
        let signal = null;
        const price_up = closePx >= P;
        const rsi_up = currRSI >= 50;
        const trend_bullish = currE20 > currE50;
        const trend_bearish = currE20 < currE50;

        // Primary: Pivot + RSI Confluence (Fast)
        if (price_up && rsi_up) signal = 'LONG';
        else if (!price_up && !rsi_up) signal = 'SHORT';
        // Secondary: Trend Fallback
        else if (trend_bullish) signal = 'LONG';
        else if (trend_bearish) signal = 'SHORT';
        else signal = price_up ? 'LONG' : 'SHORT'; // Ultimate Tie-breaker

        // --- --- IF IN POSITION: ATOMIC FLIP --- ---
        if (stBotPosition) {
            if (isNewCandle) rsiEmaPivotLastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'rsi_ema_pivot');

            const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
            if (shouldFlip) {
                logEngine(`? RSI-EMA-PIVOT ATOMIC FLIP: Signal reversed, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    // Close Main
                    if (engineTradeMode === 'real') await stBotCloseReal('RSI-Pivot Flip');
                    else stBotClosePosition(lastPrice, 'RSI-Pivot Flip');

                    // ATOMIC: Open new opposite immediately
                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) stBotOpenPosition(signal, lastPrice, null);
                    } else {
                        stBotOpenPosition(signal, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'RSI_EMA_PIVOT';
                } finally { isStBotBusy = false; }
                return;
            }

            // Stat Log
            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [RSI-PIVOT] Active ${pos.side} | RSI:${currRSI.toFixed(1)} | PnL: $${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | RSI:${currRSI.toFixed(1)} | PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) rsiEmaPivotLastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? RSI-EMA-PIVOT ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | RSI=${currRSI.toFixed(1)} | Pivot=${formatPrice(P)}`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'RSI_EMA_PIVOT';
            } finally { isStBotBusy = false; }
        } else {
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `SCANNING... RSI: ${currRSI.toFixed(1)}`;
        }
    } catch (err) {
        logEngine(`? RSI-EMA-PIVOT ERROR: ${err.message}`, 'error');
        console.error('[RSI-Pivot] Analysis error:', err);
    }
}



// ============================================================
// ADAPTIVE COMBO BOT (GRID + DCA)
// ============================================================

// --- ADX Calculation (True Strength) ---
function calcADX(data, period = 14) {
    if (data.length < period + 2) return null;
    const smoothed = (arr, prev, p) => {
        if (prev === null) return arr.slice(0, p).reduce((a, b) => a + b, 0);
        return prev - (prev / p) + arr[arr.length - 1];
    };

    let plusDMs = [], minusDMs = [], trs = [];
    for (let i = 1; i < data.length; i++) {
        const h = data[i].high, l = data[i].low, c = data[i - 1].close;
        const upMove = h - data[i - 1].high;
        const downMove = data[i - 1].low - l;
        plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
        trs.push(Math.max(h - l, Math.abs(h - c), Math.abs(l - c)));
    }

    // Wilder smoothing
    let smTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
    let smPlus = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let smMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let dx = [];
    for (let i = period; i < trs.length; i++) {
        smTR = smTR - (smTR / period) + trs[i];
        smPlus = smPlus - (smPlus / period) + plusDMs[i];
        smMinus = smMinus - (smMinus / period) + minusDMs[i];
        const diPlus = smTR !== 0 ? (smPlus / smTR) * 100 : 0;
        const diMinus = smTR !== 0 ? (smMinus / smTR) * 100 : 0;
        const diSum = diPlus + diMinus;
        dx.push({ diPlus, diMinus, dx: diSum !== 0 ? Math.abs(diPlus - diMinus) / diSum * 100 : 0 });
    }

    if (dx.length < period) return null;
    let adxVal = dx.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
    for (let i = period; i < dx.length; i++) {
        adxVal = (adxVal * (period - 1) + dx[i].dx) / period;
    }
    const last = dx[dx.length - 1];
    return { adx: adxVal, diPlus: last.diPlus, diMinus: last.diMinus };
}

// --- Combo Bot State ---
// --- Combo Bot State ---
let comboState = {
    lastCandleTime: 0
};

async function handleComboBot() {
    try {
        isEngineActive = document.getElementById('engine-toggle')?.checked;
        if (!isEngineActive) return;
        if (isStBotBusy) return;

        const mode = document.getElementById('engine-mode')?.value;
        if (mode !== 'combo_bot') return;

        const effectiveKlines = candleCache[tradeIntervalSecs] || [];
        const n = effectiveKlines.length;
        if (n < 45) {
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                logEngine(`? Waiting for ${tradeInterval} data (Combo Bot)... (${n}/45)`, 'warning');
                fetchBackgroundTradeKlines();
            }
            return;
        }

        // --- READ CONFIG ---
        const adxTrendThresh = parseInt(document.getElementById('cfg-combo-adx-trend')?.value || '25');
        const adxSidewaysThresh = adxTrendThresh - 5;

        // --- INDICATORS ---
        const atr = calcATR(effectiveKlines, 14);
        const adxResult = calcADX(effectiveKlines, 14);
        if (!atr || !adxResult) return;
        const { adx, diPlus, diMinus } = adxResult;

        const closes = effectiveKlines.map(c => c.close);
        const bbResult = calcBollingerBands(closes, 20, 2.0);
        const bbUpper = bbResult.upper[n - 1];
        const bbMid = bbResult.middle[n - 1];
        const bbLower = bbResult.lower[n - 1];
        if (!bbUpper || !bbMid || !bbLower) return;

        const bbWidth = bbUpper - bbLower;
        // Simple BB Width Avg Calculation
        let bbWidthSum = 0, bbWidthCount = 0;
        for (let i = Math.max(0, n - 50); i < n; i++) {
            const s = closes.slice(Math.max(0, i - 20), i);
            if (s.length < 20) continue;
            const m = s.reduce((a, b) => a + b, 0) / 20;
            const std = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
            bbWidthSum += std * 4;
            bbWidthCount++;
        }
        const bbWidthAvg = bbWidthCount > 0 ? bbWidthSum / bbWidthCount : bbWidth;

        const lookback = 20;
        let swingHigh = -Infinity, swingLow = Infinity;
        for (let i = Math.max(0, n - 1 - lookback); i <= n - 2; i++) {
            if (effectiveKlines[i].high > swingHigh) swingHigh = effectiveKlines[i].high;
            if (effectiveKlines[i].low < swingLow) swingLow = effectiveKlines[i].low;
        }

        const latestCandleTime = effectiveKlines[n - 1].time;
        const isNewCandle = latestCandleTime !== comboState.lastCandleTime;

        // --- REGIME DETECTION (Voting) ---
        let trendScore = 0;
        if (adx > adxTrendThresh) trendScore += 2;
        else if (adx > adxSidewaysThresh) trendScore += 1;

        if (bbWidth > bbWidthAvg * 1.2) trendScore += 2;
        else if (bbWidth > bbWidthAvg * 0.8) trendScore += 1;

        const rangeRatio = (swingHigh - swingLow) / (atr * 20);
        if (rangeRatio > 2.0) trendScore += 2;
        else if (rangeRatio > 1.2) trendScore += 1;

        const regime = trendScore >= 4 ? 'TRENDING' : (trendScore <= 2 ? 'SIDEWAYS' : 'TRANSITION');
        const signal = (diPlus > diMinus) ? 'LONG' : 'SHORT';

        // --- IF IN POSITION: ATOMIC FLIP ---
        if (stBotPosition) {
            if (isNewCandle) comboState.lastCandleTime = latestCandleTime;
            const pos = stBotPosition;
            const isLong = pos.side === 'LONG';
            const pnlUSD = (pos.notional / pos.entryPrice) * (isLong ? lastPrice - pos.entryPrice : pos.entryPrice - lastPrice);

            // Monitoring & Advanced Trade Management
            monitorBotTrade(pos, lastPrice, effectiveKlines, 'combo_bot');

            const shouldFlip = (isLong && signal === 'SHORT') || (!isLong && signal === 'LONG');
            if (shouldFlip) {
                logEngine(`? COMBO ATOMIC FLIP: Regime ${regime} Score ${trendScore}/6, reversing to ${signal}...`, 'warning');
                isStBotBusy = true;
                try {
                    if (engineTradeMode === 'real') await stBotCloseReal('Combo Flip');
                    else stBotClosePosition(lastPrice, 'Combo Flip');

                    if (engineTradeMode === 'real') {
                        const success = await stBotOpenReal(signal);
                        if (success) stBotOpenPosition(signal, lastPrice, null);
                    } else {
                        stBotOpenPosition(signal, lastPrice, null);
                    }
                    if (stBotPosition) stBotPosition.source = 'COMBO_BOT';
                } finally { isStBotBusy = false; }
                return;
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
                logEngine(`📊 [COMBO] Active ${pos.side} | Regime:${regime} Score:${trendScore}/6 PnL:$${pnlUSD.toFixed(2)}`, 'info');
            }
            if (document.getElementById('engine-direction-val')) document.getElementById('engine-direction-val').textContent = `${pos.side} | ${regime} (${trendScore}/6) PnL:$${pnlUSD.toFixed(2)}`;
            return;
        }

        if (isNewCandle) comboState.lastCandleTime = latestCandleTime;

        // --- NO POSITION: Entry ---
        if (signal) {
            logEngine(`? COMBO ENTRY: ${signal} NOW! @ ${formatPrice(lastPrice)} | Regime: ${regime} (${trendScore}/6)`, 'success');
            isStBotBusy = true;
            try {
                if (engineTradeMode === 'real') {
                    const success = await stBotOpenReal(signal);
                    if (success) stBotOpenPosition(signal, lastPrice, null);
                } else {
                    stBotOpenPosition(signal, lastPrice, null);
                }
                if (stBotPosition) stBotPosition.source = 'COMBO_BOT';
            } finally { isStBotBusy = false; }
        }
    } catch (err) {
        logEngine(`? COMBO-BOT ERROR: ${err.message}`, 'error');
        console.error('[Combo Bot] Error:', err);
    }
}

// Legacy Backtest functions (startBacktest, runHistoricalStrategy) removed.


window.visualizeTrade = function (entryTimeStr, exitTimeStr, entryPx, exitPx, side, pnl) {
    if (!candleSeries) return;

    // Parse times. Lightweight charts uses UNIX seconds.
    // "2024-03-09 16:03:00" -> Date object -> seconds
    const eTime = Math.floor(new Date(entryTimeStr).getTime() / 1000);
    const xTime = Math.floor(new Date(exitTimeStr).getTime() / 1000);

    const markers = [
        {
            time: eTime,
            position: side.toLowerCase().includes('long') ? 'belowBar' : 'aboveBar',
            color: side.toLowerCase().includes('long') ? '#0ecb81' : '#f6465d',
            shape: side.toLowerCase().includes('long') ? 'arrowUp' : 'arrowDown',
            text: `Open ${side}\n@ ${entryPx.toFixed(2)}`
        },
        {
            time: xTime,
            position: pnl >= 0 ? 'aboveBar' : 'belowBar',
            color: pnl >= 0 ? '#0ecb81' : '#f6465d',
            shape: 'circle',
            text: `Close\nPnL: $${pnl.toFixed(2)}`
        }
    ];

    candleSeries.setMarkers(markers);

    // Pan the camera smoothly to the trade window
    if (chart) {
        chart.timeScale().setVisibleRange({
            from: eTime - (xTime - eTime) - 300, // Lookback padding
            to: xTime + (xTime - eTime) + 300 // Lookahead padding
        });
    }
};

// ============================================================
// BINANCE-STYLE ORDER PANEL 
// ============================================================

function initBinanceOrderPanel() {
    // Hooks
    const priceInput = document.getElementById('order-price');
    const amountInput = document.getElementById('order-amount');
    const slider = document.getElementById('order-slider');
    const levInput = document.getElementById('leverage-slider');

    const btnLong = document.getElementById('btn-open-long');
    const btnShort = document.getElementById('btn-open-short');

    // Attach dual-button submit execution
    btnLong?.addEventListener('click', () => submitManualOrder('LONG'));
    btnShort?.addEventListener('click', () => submitManualOrder('SHORT'));

    // Dynamically update UI when inputs change
    const updateUI = () => updateOrderPanelEstimates(priceInput, amountInput, levInput, slider);

    priceInput?.addEventListener('input', updateUI);
    amountInput?.addEventListener('input', updateUI);
    levInput?.addEventListener('input', updateUI);
    slider?.addEventListener('input', () => {
        // Slider sets % size of max available margin
        const balStr = document.getElementById('header-balance')?.innerText || '0';
        const rawBal = parseFloat(balStr.replace(/[^0-9.]/g, '')) || 0;
        const pct = slider.value / 100;
        if (amountInput) amountInput.value = (rawBal * pct).toFixed(2);
        updateUI();
    });

    // Run every second to catch lastPrice or balance drifts
    setInterval(updateUI, 1000);
}

function updateOrderPanelEstimates(priceInput, amountInput, levInput, slider) {
    // 1. Fetch live balance from DOM header
    const balStr = document.getElementById('header-balance')?.innerText || '0';
    let rootBal = parseFloat(balStr.replace(/[^0-9.]/g, '')) || 0;
    if (rootBal <= 0) rootBal = 1000; // default simulation balance

    let activeMargin = 0;
    const isR = document.getElementById('trade-mode')?.value === 'REAL';
    if (!isR && typeof paperPositions !== 'undefined') {
        paperPositions.forEach(p => activeMargin += p.margin);
    }
    let availBal = rootBal - activeMargin;
    if (availBal < 0) availBal = 0;

    document.getElementById('order-avbl').innerText = availBal.toFixed(4) + ' USDT';

    // 2. Values
    let price = parseFloat(priceInput?.value) || (typeof lastPrice !== 'undefined' ? lastPrice : 1);
    let marginSize = parseFloat(amountInput?.value) || 0;
    let lev = parseInt(levInput?.value) || 10;

    let notional = marginSize * lev;
    let maxNotional = availBal * lev;

    // 3. Update Max
    document.getElementById('max-buy-val').innerText = maxNotional.toFixed(5) + ' USDT';
    document.getElementById('max-sell-val').innerText = maxNotional.toFixed(5) + ' USDT';

    // 4. Update Detailed Stats (Long)
    let liqLong = price - (price / lev);
    if (liqLong < 0) liqLong = 0;
    document.getElementById('stat-liq-long').innerText = liqLong.toFixed(5) + ' USDT';
    document.getElementById('stat-cost-long').innerText = marginSize.toFixed(4) + ' USDT';
    document.getElementById('stat-max-long').innerText = maxNotional.toFixed(2) + ' USDT';

    // 5. Update Detailed Stats (Short)
    let liqShort = price + (price / lev);
    document.getElementById('stat-liq-short').innerText = liqShort.toFixed(5) + ' USDT';
    document.getElementById('stat-cost-short').innerText = marginSize.toFixed(4) + ' USDT';
    document.getElementById('stat-max-short').innerText = maxNotional.toFixed(2) + ' USDT';

    // 6. Update Account Widget (Mock values proportional to active bal)
    document.getElementById('acc-margin-ratio').innerText = (100 / lev).toFixed(2) + '%';
    document.getElementById('acc-margin-bar').style.width = (100 / lev) + '%';
    // Maint margin usually 0.4% to 1% of notional + active pos
    let maint = (maxNotional * 0.004);
    document.getElementById('acc-maint-margin').innerText = maint.toFixed(4) + ' USDT';
    document.getElementById('acc-margin-bal').innerText = availBal.toFixed(4) + ' USDT';
    document.getElementById('acc-wallet-bal').innerText = rootBal.toFixed(4) + ' USDT';

    // True Unrealized PNL mapping:
    // If REAL mode: grab from real api totalUnrealizedProfit (surfaced via header-pnl)
    // If SIM mode: calculate from paper positions
    let unrealized = 0;
    const isReal = document.getElementById('trade-mode')?.value === 'REAL';

    if (isReal) {
        const pnlStr = document.getElementById('header-pnl')?.innerText || '0';
        unrealized = parseFloat(pnlStr.replace(/[^0-9.-]/g, '')) || 0;
    } else {
        if (typeof paperPositions !== 'undefined') {
            paperPositions.forEach(p => {
                const isLong = p.side === 'LONG' || p.side === 'BUY';
                const cp = (p.symbol === currentSymbol) ? price : p.entryPrice;
                const diff = isLong ? cp - p.entryPrice : p.entryPrice - cp;
                unrealized += (p.amount / p.entryPrice) * diff;
            });
        }
    }

    const sign = unrealized > 0 ? '+' : '';
    document.getElementById('acc-unrealized-pnl').innerText = `${sign}$${unrealized.toFixed(2)} USDT`;
    document.getElementById('acc-unrealized-pnl').style.color = unrealized >= 0 ? 'var(--up)' : 'var(--down)';
}

async function submitManualOrder(side) {
    const isReal = document.getElementById('trade-mode')?.value === 'REAL';
    const amountStr = document.getElementById('order-amount')?.value;
    const levStr = document.getElementById('leverage-slider')?.value;

    // Simulate API connection hook for newly constructed button
    logEngine(`Manual ${side} Request Triggered`, 'info');

    try {
        const payload = {
            symbol: currentTicker,
            side: side,
            margin: parseFloat(amountStr) || 10,
            price: typeof lastPrice !== 'undefined' ? lastPrice : 0,
            leverage: parseInt(levStr) || 10
        };

        const endpoint = isReal ? '/api/real/order' : '/api/sim/order';
        const res = await fetch(`http://localhost:8080${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
            logEngine(`Successfully executed manual ${side} on ${currentTicker}`, 'success');
        } else {
            logEngine(`Order rejected: ${data.message || 'Unknown error'}`, 'error');
        }
    } catch (e) {
        logEngine(`Connection error establishing manual order.`, 'error');
    }
}

// Auto-detect env port
const envPortEl = document.getElementById('env-current-port');
if (envPortEl) {
    const currentPort = location.port || '8000';
    envPortEl.textContent = ':' + currentPort;

    // Highlight correct button
    document.querySelectorAll('.env-btn').forEach(btn => {
        if (btn.innerText.includes(currentPort)) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

function switchEnv(port) {
    if (location.port === port) return;
    const currentHost = location.hostname || 'localhost';
    window.open(`http://${currentHost}:${port}`, '_blank');
}

// Bootstrap
setTimeout(initBinanceOrderPanel, 1500);

// ============================================================
// SETTINGS
// ============================================================
function saveSettings() {
    botConfig.supertrend.atrPeriod = parseInt(document.getElementById('cfg-st-atr')?.value) || 10;
    botConfig.supertrend.factor = parseFloat(document.getElementById('cfg-st-factor')?.value) || 3.0;

    botConfig.parabolicSAR.start = parseFloat(document.getElementById('cfg-sar-start')?.value) || 0.02;
    botConfig.parabolicSAR.increment = botConfig.parabolicSAR.start;
    botConfig.parabolicSAR.max = parseFloat(document.getElementById('cfg-sar-max')?.value) || 0.2;

    botConfig.adx.length = parseInt(document.getElementById('cfg-adx-len')?.value) || 14;
    botConfig.adx.threshold = parseInt(document.getElementById('cfg-adx-thresh')?.value) || 25;

    document.getElementById('settings-modal').classList.add('hidden');
    showToast('Trading settings saved & deployed.', 'success');
}

// ============================================================
// ALGORITHMIC RECOMMENDED TRADES � Real Backtest Screener (SSE Live)
// ============================================================
let recTradeScanning = false;
let currentRecSort = { col: "pnl", desc: true };

function _buildResultCard(sym, resultsArray, rank) {
    if (!resultsArray || resultsArray.length === 0) return document.createElement('div');
    resultsArray.sort((a, b) => b.net_pnl - a.net_pnl);
    const best = resultsArray[0];
    const isProfit = best.net_pnl >= 0;
    const pnlColor = isProfit ? 'var(--up)' : 'var(--down)';

    const div = document.createElement('div');
    div.className = `rec-card-premium ${isProfit ? 'profit' : 'loss'}`;
    div.dataset.sym = sym;
    div.dataset.pnl = best.net_pnl;
    div.dataset.winrate = best.win_rate;
    div.dataset.trades = best.trades;
    div.dataset.dd = best.max_dd;

    div.innerHTML = `
        <div class="rec-row-compact" style="display:flex; align-items:center; width:100%; gap:12px; padding:4px 8px; font-size:11px;">
            <span style="width:20px; font-weight:700; color:var(--text-secondary); text-align:center;" class="rank-badge">${rank}</span>
            
            <div style="width:100px; font-weight:700; color:var(--text-primary); cursor:pointer;" onclick="switchSymbol('${sym}'); closeScreener();">
                ?? ${sym.replace('USDT', '')}
            </div>
            
            <div style="flex:1; color:var(--text-secondary); font-size:10px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">
                ${best.strategy.replace(/_/g, ' ').toUpperCase()} <span style="opacity:0.5;">(${best.interval})</span>
            </div>
            
            <div style="width:70px; text-align:right; font-weight:700; color:${pnlColor}; font-family:var(--mono);">
                ${isProfit ? '+' : ''}$${best.net_pnl.toFixed(2)}
            </div>
            
            <div style="width:55px; text-align:right; color:${best.win_rate >= 50 ? 'var(--up)' : 'var(--text-secondary)'}; font-weight:600;">
                ${best.win_rate.toFixed(1)}%
            </div>
            
            <div style="width:45px; text-align:right; color:var(--text-secondary);">
                ${best.trades}
            </div>
            
            <div style="width:55px; text-align:right; color:var(--down); font-weight:600;">
                -${best.max_dd.toFixed(1)}%
            </div>
            
            <div style="width:60px; text-align:right;">
                <button class="btn-test-setup" onclick="triggerDeepLinkBacktest('${sym}', '${best.interval}', '${best.strategy}')" 
                    style="padding:2px 8px; font-size:9px; height:20px; border-radius:2px;">? Test</button>
            </div>
        </div>
        `;
    requestAnimationFrame(() => { div.style.opacity = '1'; });
    div.addEventListener('mouseenter', () => div.style.transform = 'translateY(-1px)');
    div.addEventListener('mouseleave', () => div.style.transform = 'none');
    return div;
}
function _reRankCards(wrap) {
    if (!wrap) return;
    const cards = [...wrap.querySelectorAll('.rec-card-premium')];
    cards.sort((a, b) => {
        let valA = parseFloat(a.dataset[currentRecSort.col]) || 0;
        let valB = parseFloat(b.dataset[currentRecSort.col]) || 0;

        // DD is a negative value mentally (like -60%), but stored absolute or negative?
        // Let's rely on standard numerical sort.
        if (currentRecSort.col === 'dd') {
            // Smaller drawdown is better usually, but user decides desc/asc
        }

        return currentRecSort.desc ? valB - valA : valA - valB;
    });

    cards.forEach((card, i) => {
        const badge = card.querySelector('.rank-badge');
        if (badge) {
            badge.textContent = i + 1;
            // Update badge color based on rank
            badge.style.color = (i < 3) ? 'var(--brand)' : 'var(--text-secondary)';
        }
        wrap.appendChild(card);
    });
}

async function generateRecommendedTrades() {
    const container = document.getElementById('rectrade-cards-container');
    if (!container) return;
    if (recTradeScanning) return;

    if (!cachedScreenerData || cachedScreenerData.length === 0) {
        container.innerHTML = `<div style="color:var(--text-secondary);text-align:center;padding:20px;font-size:11px;">No market data � let the screener load first.</div>`;
        return;
    }

    const stratEl = document.querySelectorAll('#rec-strategy');
    const ivEl = document.querySelectorAll('#rec-interval');
    const strategy = stratEl.length > 0 ? stratEl[stratEl.length - 1].value : 'all';
    const interval = ivEl.length > 0 ? ivEl[ivEl.length - 1].value : 'all';

    const levEl = document.querySelectorAll('#rec-leverage');
    const sizeEl = document.querySelectorAll('#rec-size');
    const leverage = levEl.length > 0 ? parseInt(levEl[levEl.length - 1].value) : 10;
    const size = sizeEl.length > 0 ? parseFloat(sizeEl[sizeEl.length - 1].value) : 100;

    let fullSyms = [...cachedScreenerData].sort((a, b) => b.quoteVolume - a.quoteVolume).map(d => d.symbol);
    if (interval === 'all' && strategy === 'all' && fullSyms.length > 200) fullSyms = fullSyms.slice(0, 200);
    const symbols = fullSyms;
    const port = location.port || '8000';

    recTradeScanning = true;
    let total = 0, done = 0, found = 0;
    const screenerResultsMap = {};

    container.innerHTML = `
        <div id="rec-progress-wrap" style="padding:4px 15px; background:rgba(240,185,11,0.03); border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
                <span id="rec-header-text" style="font-size:10px; color:var(--brand); font-weight:700;">📊 INITIALIZING...</span>
                <span id="rec-pct-label" style="font-size:10px; font-weight:900; color:var(--text-primary);">0%</span>
            </div>
            <div style="height:2px; background:rgba(255,255,255,0.05); border-radius:1px; overflow:hidden;">
                <div id="rec-progress-bar" style="height:100%; width:0%; background:var(--brand); transition:width 0.2s;"></div>
            </div>
            <div id="rec-current-ticker" style="font-size:9px; color:var(--text-muted); font-family:var(--mono); margin-top:2px;">Waiting...</div>
        </div>
        
        <div style="display:flex; align-items:center; padding:8px 15px; font-size:10px; color:var(--text-muted); border-bottom:1px solid rgba(255,255,255,0.05); background:rgba(0,0,0,0.1);" id="rec-sort-header">
            <span style="width:20px; text-align:center;">#</span>
            <span style="width:100px; font-weight:700; color:var(--text-secondary); margin-left:12px;">SYMBOL</span>
            <span style="flex:1;">STRATEGY</span>
            <div data-col="pnl" class="rec-sort-btn" style="cursor:pointer; width:70px; text-align:right; font-weight:700; color:var(--brand);">PnL ?</div>
            <div data-col="winrate" class="rec-sort-btn" style="cursor:pointer; width:55px; text-align:right;">Win Rate</div>
            <div data-col="trades" class="rec-sort-btn" style="cursor:pointer; width:45px; text-align:right;">Trades</div>
            <div data-col="dd" class="rec-sort-btn" style="cursor:pointer; width:55px; text-align:right;">Max DD</div>
            <div style="width:60px;"></div>
        </div>
        
        <div id="rec-live-cards" style="display:flex; flex-direction:column;"></div>`;

    setTimeout(() => {
        document.querySelectorAll('.rec-sort-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const col = e.target.dataset.col;
                if (currentRecSort.col === col) {
                    currentRecSort.desc = !currentRecSort.desc;
                } else {
                    currentRecSort.col = col;
                    currentRecSort.desc = true;
                }
                document.querySelectorAll('.rec-sort-btn').forEach(b => {
                    b.style.fontWeight = b.dataset.col === currentRecSort.col ? '700' : 'normal';
                    b.style.color = b.dataset.col === currentRecSort.col ? 'var(--brand)' : 'var(--text-secondary)';
                    b.textContent = b.textContent.replace(' ?', '').replace(' ?', '');
                    if (b.dataset.col === currentRecSort.col) b.textContent += currentRecSort.desc ? ' ?' : ' ?';
                });
                _reRankCards(document.getElementById('rec-live-cards'));
            });
        });
    }, 100);

    const barEl = document.getElementById('rec-progress-bar');
    const pctEl = document.getElementById('rec-pct-label');
    const tickEl = document.getElementById('rec-current-ticker');
    const foundEl = document.getElementById('rec-found-count');
    const cardsEl = document.getElementById('rec-live-cards');

    // ? INITIALIZE ABORT CONTROLLER BEFORE FETCH
    if (screenerAbortController) screenerAbortController.abort();
    screenerAbortController = new AbortController();

    try {
        const resp = await fetch(`http://localhost:${port}/api/screener-backtest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbols, strategy, interval, leverage, size }),
            signal: screenerAbortController.signal
        });

        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';

        while (true) {
            const { value, done: rd } = await reader.read();
            if (rd) break;
            buf += dec.decode(value, { stream: true });

            const lines = buf.split('\n');
            buf = lines.pop();

            for (const line of lines) {
                if (!line || !line.startsWith('data:')) continue;
                try {
                    const dataStr = line.slice(5).trim();
                    if (!dataStr) continue;
                    const evt = JSON.parse(dataStr);
                    if (evt.type === 'start') {
                        total = evt.total;
                        const hdr = document.getElementById('rec-header-text');
                        if (hdr) hdr.textContent = `\u26a1 Scanning ${total} jobs...`;
                    } else if (evt.type === 'progress') {
                        done = evt.done;
                        const pct = Math.round(done / total * 100);
                        if (barEl) barEl.style.width = pct + '%';
                        if (pctEl) pctEl.textContent = pct + '%';
                        if (tickEl) tickEl.textContent = `Scanning: ${evt.symbol}  (${done}/${total})`;
                    } else if (evt.type === 'result') {
                        if (!screenerResultsMap[evt.symbol]) {
                            screenerResultsMap[evt.symbol] = [];
                            found++;
                            if (foundEl) foundEl.textContent = `\u2705 ${found} tickers found`;
                        }
                        // Cap per-symbol results to avoid unbounded memory growth
                        screenerResultsMap[evt.symbol].push(...evt.results);
                        if (screenerResultsMap[evt.symbol].length > 500) {
                            screenerResultsMap[evt.symbol] = screenerResultsMap[evt.symbol].slice(-500);
                        }

                        // Find and replace the card for this symbol, or append if new.
                        if (cardsEl) {
                            let existing = cardsEl.querySelector(`.rec-card[data-sym="${evt.symbol}"]`);
                            let newCard = _buildResultCard(evt.symbol, screenerResultsMap[evt.symbol], found);
                            if (existing) {
                                cardsEl.replaceChild(newCard, existing);
                            } else {
                                cardsEl.appendChild(newCard);
                            }
                            _reRankCards(cardsEl);
                        }
                    } else if (evt.type === 'done') {
                        if (barEl) barEl.style.width = '100%';
                        if (pctEl) pctEl.textContent = '100%';
                        const wrap = document.getElementById('rec-progress-wrap');
                        if (wrap) wrap.innerHTML = `<div style="font-size:11px;color:var(--text-secondary);padding:4px 0 8px;display:flex;justify-content:space-between;">
                            <span>Scan complete \u00b7 ${strategy === 'all' ? 'All Strategies' : strategy} \u00b7 ${interval === 'all' ? 'All TFs' : interval}</span>
                            <span style="color:${found > 0 ? 'var(--up)' : 'var(--down)'};">\u2705 ${found} ticker${found !== 1 ? 's' : ''} found</span>
                        </div>`;
                        if (found === 0 && cardsEl) cardsEl.innerHTML = `<div style="color:var(--text-secondary);text-align:center;padding:16px;font-size:12px;">No setups found for this scan.</div>`;
                        _reRankCards(cardsEl);
                    }
                } catch (err) {
                    console.error("SSE parse/render error:", err, line);
                }
            }
        }
    } catch (e) {
        container.innerHTML = `<div style="color:var(--down);text-align:center;padding:16px;font-size:12px;">Error: ${e.message}<br><span style="color:var(--text-secondary)">Check that run_servers.bat is running.</span></div>`;
    } finally {
        recTradeScanning = false;
    }
}



// ============================================================
// BACKTEST ENGINE (SIMULATES LIVE BOT LOGIC)
// ============================================================
// ============================================================
// BACKTEST ENGINE (SIMULATES LIVE BOT LOGIC)
// ============================================================

async function runBacktest() {
    const btn = document.getElementById('backtest-start-btn');
    const logEl = document.getElementById('backtest-log');
    if (!btn || !logEl) return;

    if (!candleData || candleData.length < 50) {
        logEl.innerHTML = `<div style="padding:10px;text-align:center;color:var(--down);">Not enough chart data loaded (${candleData ? candleData.length : 0} candles). Please wait for the chart to load or zoom out.</div>`;
        return;
    }

    btn.innerText = '🧪 Running Python Simulation...';
    btn.disabled = true;
    logEl.innerHTML = `<div style="padding:10px;text-align:center;color:var(--text-secondary);">Sending ${candleData.length} candles from current chart to server...</div>`;

    const strategy = document.getElementById('backtest-strategy').value || 'pure_supertrend';
    const lev = parseInt(document.getElementById('backtest-leverage').value) || 10;
    const size = parseFloat(document.getElementById('backtest-betsize').value) || 100;
    const currentPort = location.port || '8000';

    try {
        // Send raw OHLCV only. Python server computes all indicators authoritatively
        // to prevent mismatch with the visual chart, we MUST send the exact candleData array
        // that the UI is currently rendering.
        const payload = {
            symbol: currentSymbol,
            candles: candleData,
            strategy: strategy,
            leverage: lev,
            size: size,
            enable_hedge: document.getElementById('bt-enable-hedge')?.checked,
            hedge_tf: document.getElementById('bt-hedge-tf')?.value || '1m'
        };

        const r = await fetch(`http://localhost:${currentPort}/api/backtest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const res = await r.json();

        if (!r.ok || res.error) {
            throw new Error(res.error || 'Unknown backtest error');
        }

        const metrics = res.metrics;
        const trades = res.trades || [];
        lastBacktestTrades = trades;

        // Render Results
        document.getElementById('bt-pnl').innerText = `$${metrics.net_profit.toFixed(2)}`;
        document.getElementById('bt-pnl').style.color = metrics.net_profit >= 0 ? 'var(--up)' : 'var(--down)';
        document.getElementById('bt-winrate').innerText = `${metrics.win_rate.toFixed(1)}%`;
        document.getElementById('bt-trades').innerText = metrics.total_trades;
        document.getElementById('bt-mdd').innerText = `-$${metrics.max_drawdown_pct.toFixed(2)}`;

        renderBacktestHistory();

    } catch (e) {
        logEl.innerHTML = `<div style="padding:10px;text-align:center;color:var(--down);">Server Error: ${e.message}</div>`;
    } finally {
        btn.innerText = '🧪 Run Backtest';
        btn.disabled = false;
    }
}

function renderBacktestHistory() {
    const logEl = document.getElementById('backtest-log');
    if (!logEl || !lastBacktestTrades) return;

    const includeHedge = document.getElementById('bt-filter-hedge')?.checked;
    const strategy = document.getElementById('backtest-strategy').value || 'pure_supertrend';

    const filtered = includeHedge ? lastBacktestTrades : lastBacktestTrades.filter(t => !t.is_hedge);

    if (filtered.length === 0) {
        logEl.innerHTML = `<div style="padding:10px;text-align:center;color:var(--text-secondary);">No trades found (Filters active).</div>`;
        return;
    }

    let logHtml = '';
    // trades are returned chronological, we reverse for UI
    [...filtered].reverse().forEach(t => {
        const color = t.pnl >= 0 ? 'var(--up)' : 'var(--down)';
        const sColor = t.side.includes('Long') ? 'var(--up)' : 'var(--down)';
        const entryT = String(t.entry_time).replace(/'/g, "\\'");
        const exitT = String(t.exit_time).replace(/'/g, "\\'");

        const isHedge = t.is_hedge;
        const hedgeLabel = isHedge ? `<span style="color:var(--brand); font-size:8px; border:1px solid var(--brand); padding:0 2px; border-radius:2px; margin-bottom:2px; width:fit-content;">HEDGE</span>` : '';
        const savedLabel = t.pnl_saved ? `<div style="color:var(--brand); font-size:9px;">Saved: +$${t.pnl_saved.toFixed(2)}</div>` : '';
        const reasonStr = t.hedge_status ? `<span style="font-style:italic;">${t.hedge_status}</span>` : t.reason;

        logHtml += `
            <div style="display:grid; grid-template-columns: 50px 1fr 1fr 40px 1fr 60px; gap:8px; padding:6px 10px; font-size:10px; border-bottom:1px solid rgba(255,255,255,0.05); font-family:var(--mono); align-items:center;">
                <div style="display:flex; flex-direction:column; gap:2px;">
                    ${hedgeLabel}
                    <span style="color:${sColor}">${t.side}</span>
                    <button onclick="visualizeTrade('${entryT}', '${exitT}', ${t.entry}, ${t.exit}, '${t.side}', ${t.pnl})" 
                        style="background:var(--bg-elevated); border:1px solid var(--border); color:var(--brand); font-size:9px; padding:2px; cursor:pointer; border-radius:2px;">
                        📊 See
                    </button>
                </div>
                <span>$${t.entry.toFixed(4)}</span>
                <span>$${t.exit.toFixed(4)}</span>
                <span style="color:var(--text-secondary);">${t.lev}x</span>
                <div style="display:flex; flex-direction:column;">
                    <span style="color:var(--text-secondary);">${reasonStr}</span>
                    ${savedLabel}
                </div>
                <span style="text-align:right;color:${color}">${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}</span>
            </div>
        `;
    });
    logEl.innerHTML = logHtml;
}
window.renderBacktestHistory = renderBacktestHistory;


window.triggerDeepLinkBacktest = async function (sym, interval, strategy) {
    if (typeof closeScreener === 'function') closeScreener();

    document.getElementById('backtest-strategy').value = strategy;

    // Switch but do not double fetch
    if (currentSymbol !== sym.toUpperCase()) {
        currentSymbol = sym.toUpperCase();
        const select = document.getElementById('symbol-select');
        if (select) select.value = currentSymbol;
        const hd = document.getElementById('header-symbol');
        if (hd) hd.textContent = currentSymbol;
        const tl = document.getElementById('market-ticker-label');
        if (tl) {
            let displaySym = currentSymbol;
            if (currentSymbol.endsWith('USDT')) displaySym = currentSymbol.replace('USDT', '/USDT');
            tl.textContent = displaySym;
        }
        if (typeof connectPriceWs === 'function') connectPriceWs();
        if (typeof connectKlineWs === 'function') connectKlineWs();
        if (typeof connectOrderbookWs === 'function') connectOrderbookWs();
        if (typeof connectTickerWs === 'function') connectTickerWs();
    }

    currentInterval = interval.toLowerCase();
    document.querySelectorAll('.tf-btn').forEach(b => {
        b.classList.remove('active');
        if (b.dataset.tf && b.dataset.tf.toLowerCase() === currentInterval) {
            b.classList.add('active');
        }
    });

    if (typeof loadKlines === 'function') {
        await loadKlines();
        // Give UI thread a tiny breather to finish rendering chart
        setTimeout(() => runBacktest(), 50);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('cfg-hedge-tf')?.addEventListener('change', () => {
        const tfSecs = parseInt(document.getElementById('cfg-hedge-tf').value);
        candleCache[tfSecs] = []; // Flush old cache for new timeframe
        notifyActiveContext();    // Notify Central Hub
        connectHedgeKlineWs();    // reconnect background hedge
        fetchBackgroundHedgeKlines();
    });

    // Initialize Central Sync Hub
    setTimeout(() => {
        initCentralStream();
        notifyActiveContext();
    }, 2000);
});

// --- Config Copy/Paste ---
function copyControlCenterConfig() {
    const config = {};
    const container = document.querySelector('.compact-control');
    if (!container) return;

    const inputs = container.querySelectorAll('input, select');
    inputs.forEach(el => {
        if (!el.id || el.id === 'engine-toggle') return;
        // Exclude SIM/REAL buttons by checking if they belong to the toggle group
        if (el.closest('.toggle-group-small')) return;

        if (el.type === 'checkbox') config[el.id] = el.checked;
        else config[el.id] = el.value;
    });

    const json = JSON.stringify(config, null, 2);
    navigator.clipboard.writeText(json).then(() => {
        if (typeof logEngine === 'function') {
            logEngine('📋 Configuration copied to clipboard!', 'success');
        } else {
            alert('📋 Configuration copied to clipboard!');
        }
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard');
    });
}

function pasteControlCenterConfig() {
    navigator.clipboard.readText().then(text => {
        try {
            const config = JSON.parse(text);
            let count = 0;
            for (const id in config) {
                const el = document.getElementById(id);
                if (el) {
                    // Exclude SIM/REAL just in case they were captured
                    if (el.closest('.toggle-group-small')) continue;

                    if (el.type === 'checkbox') el.checked = config[id];
                    else el.value = config[id];

                    // Trigger change event to ensure bot state updates
                    el.dispatchEvent(new Event('change'));
                    count++;
                }
            }
            if (typeof logEngine === 'function') {
                logEngine(`📥 Pasted ${count} settings from clipboard!`, 'success');
            } else {
                alert(`📥 Pasted ${count} settings from clipboard!`);
            }
        } catch (e) {
            if (typeof logEngine === 'function') {
                logEngine('❌ Failed to paste: Invalid JSON format', 'error');
            } else {
                alert('❌ Failed to paste: Invalid JSON format');
            }
        }
    }).catch(err => {
        console.error('Failed to read clipboard:', err);
        alert('Failed to read clipboard. Ensure you granted permissions.');
    });
}



// --- Sidebar Toggles (Unified - Active = Visible) ---
function toggleLeftSidebar() {
    const grid = document.getElementById('main-grid');
    const btn = document.getElementById('toggle-left-sidebar-btn');
    if (!grid || !btn) return;
    const isHidden = grid.classList.toggle('left-panel-hidden');
    if (isHidden) btn.classList.remove('active');
    else btn.classList.add('active');
    setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 50);
}

function toggleMiddleSidebar() {
    const grid = document.getElementById('main-grid');
    const btn = document.getElementById('toggle-middle-sidebar-btn');
    if (!grid || !btn) return;
    const isHidden = grid.classList.toggle('sidebar-hidden');
    if (isHidden) btn.classList.remove('active');
    else btn.classList.add('active');
    setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 50);
}

function toggleRightSidebar() {
    const grid = document.getElementById('main-grid');
    const btn = document.getElementById('toggle-right-sidebar-btn');
    if (!grid || !btn) return;
    const isHidden = grid.classList.toggle('right-panel-hidden');
    if (isHidden) btn.classList.remove('active');
    else btn.classList.add('active');
    setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 50);
}

function toggleBottomPanel() {
    const grid = document.getElementById('main-grid');
    const btn = document.getElementById('toggle-bottom-panel-btn');
    if (!grid || !btn) return;
    const isHidden = grid.classList.toggle('bottom-panel-hidden');
    if (isHidden) btn.classList.remove('active');
    else btn.classList.add('active');
    setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 50);
}

// --- Global Error Monitor ---
window.onerror = function (msg, url, lineNo, columnNo, error) {
    const errorMsg = `❌ JS ERROR: ${msg} | Line: ${lineNo}`;
    if (typeof logEngine === 'function') logEngine(errorMsg, 'error');
    console.error(errorMsg, error);
    return false;
};
