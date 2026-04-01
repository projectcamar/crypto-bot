/**
 * perf_engine.js — BinanceBot Performance Engine
 * Provides: visibility gating, RAF-throttled updates, batch DOM, benchmark metrics.
 * 
 * ZERO memory leaks guaranteed:
 *  - Fixed-size rolling arrays (capped)
 *  - Single RAF loop (no stacking)
 *  - WeakRef not needed (simple primitives only)
 */

(function () {
    'use strict';

    // ====== PERFORMANCE STATE ======
    const perf = {
        isVisible: !document.hidden,
        fps: 0,
        frameCount: 0,
        lastFpsTime: performance.now(),
        domWriteCount: 0,
        lastDomResetTime: performance.now(),
        // Rolling latency samples (max 30)
        latencySamples: [],
        maxSamples: 30,
        // Benchmark metrics
        avgFrameTime: 0,
        frameTimes: [],  // last 60 frame times
        maxFrameSamples: 60,
    };

    // ====== PAGE VISIBILITY API ======
    // Throttle ALL non-critical work when tab is hidden
    document.addEventListener('visibilitychange', () => {
        perf.isVisible = !document.hidden;
        if (perf.isVisible) {
            // Tab became visible — force immediate refresh
            console.log('[PERF] Tab visible — resuming full speed');
            // Notify poll worker to resume if needed
            if (window._pollWorker) {
                window._pollWorker.postMessage('start');
            }
        } else {
            console.log('[PERF] Tab hidden — throttling non-critical work');
        }
    });

    // ====== GLOBAL VISIBILITY CHECK ======
    // Other scripts call this before doing expensive DOM work
    window.perfShouldRender = function () {
        return perf.isVisible;
    };

    // ====== RAF-GATED CHART UPDATE ======
    // Instead of calling chart.update() directly, queue it through RAF
    let _chartUpdateQueued = false;
    let _profitChartUpdateQueued = false;

    window.perfQueueChartUpdate = function (chartInstance, type) {
        if (type === 'price' && !_chartUpdateQueued) {
            _chartUpdateQueued = true;
            requestAnimationFrame(() => {
                if (chartInstance && perf.isVisible) {
                    const t0 = performance.now();
                    chartInstance.update('none'); // 'none' = no animation = fastest
                    recordFrameTime(performance.now() - t0);
                }
                _chartUpdateQueued = false;
            });
        } else if (type === 'profit' && !_profitChartUpdateQueued) {
            _profitChartUpdateQueued = true;
            requestAnimationFrame(() => {
                if (chartInstance && perf.isVisible) {
                    chartInstance.update('none');
                }
                _profitChartUpdateQueued = false;
            });
        }
    };

    // ====== BATCH DOM WRITES ======
    // Collect DOM writes and flush once per frame
    const _domQueue = [];
    let _domFlushQueued = false;

    window.perfBatchDOM = function (fn) {
        _domQueue.push(fn);
        // Cap queue to 50 to absolutely prevent tab-focus freezing
        if (_domQueue.length > 50) {
            _domQueue.shift(); // Drop oldest archaic DOM updates
        }
        if (!_domFlushQueued) {
            _domFlushQueued = true;
            requestAnimationFrame(() => {
                const batch = _domQueue.splice(0);
                for (let i = 0; i < batch.length; i++) {
                    batch[i]();
                }
                perf.domWriteCount += batch.length;
                _domFlushQueued = false;
            });
        }
    };

    // ====== FPS COUNTER ======
    function fpsLoop() {
        perf.frameCount++;
        const now = performance.now();
        if (now - perf.lastFpsTime >= 1000) {
            perf.fps = perf.frameCount;
            perf.frameCount = 0;
            perf.lastFpsTime = now;
            updateBenchmarkDisplay();
        }
        requestAnimationFrame(fpsLoop);
    }
    requestAnimationFrame(fpsLoop);

    function recordFrameTime(ms) {
        perf.frameTimes.push(ms);
        if (perf.frameTimes.length > perf.maxFrameSamples) perf.frameTimes.shift();
        perf.avgFrameTime = perf.frameTimes.reduce((a, b) => a + b, 0) / perf.frameTimes.length;
    }

    // ====== LATENCY MEASUREMENT ======
    function measureLatency() {
        const t0 = performance.now();
        fetch('/api/prices', { method: 'HEAD', cache: 'no-store' })
            .then(() => {
                const ms = Math.round(performance.now() - t0);
                perf.latencySamples.push(ms);
                if (perf.latencySamples.length > perf.maxSamples) perf.latencySamples.shift();
                updateLatencyDisplay(ms);
            })
            .catch(() => {
                updateLatencyDisplay(-1);
            });
    }

    function updateLatencyDisplay(lastMs) {
        const el = document.getElementById('header-latency');
        if (!el) return;
        if (lastMs < 0) { el.textContent = '--ms'; return; }
        const avg = Math.round(perf.latencySamples.reduce((a, b) => a + b, 0) / perf.latencySamples.length);
        el.textContent = avg + 'ms';
        el.style.color = avg < 100 ? 'var(--up)' : avg < 300 ? 'var(--accent)' : 'var(--down)';
    }

    // ====== SHARPE RATIO ======
    function updateSharpe() {
        const el = document.getElementById('header-sharpe');
        if (!el) return;
        try {
            if (typeof state === 'undefined' || !state.stats || !state.stats.history || state.stats.history.length < 2) {
                el.textContent = '--';
                return;
            }
            const returns = state.stats.history.map(h => h.profit || 0);
            const n = returns.length;
            const mean = returns.reduce((a, b) => a + b, 0) / n;
            const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / n;
            const std = Math.sqrt(variance);
            if (std === 0) { el.textContent = mean > 0 ? '∞' : '0.00'; return; }
            const sharpe = (mean / std).toFixed(2);
            el.textContent = sharpe;
            el.style.color = parseFloat(sharpe) > 0 ? 'var(--up)' : parseFloat(sharpe) < 0 ? 'var(--down)' : 'var(--accent)';
        } catch (e) { el.textContent = '--'; }
    }

    // ====== BENCHMARK DISPLAY ======
    function updateBenchmarkDisplay() {
        // Update FPS in footer or create a small indicator
        const fpsEl = document.getElementById('perf-fps');
        const domEl = document.getElementById('perf-dom');
        const frameEl = document.getElementById('perf-frame');

        if (fpsEl) fpsEl.textContent = perf.fps;
        if (domEl) {
            const now = performance.now();
            const elapsed = (now - perf.lastDomResetTime) / 1000;
            const rate = Math.round(perf.domWriteCount / Math.max(elapsed, 1));
            domEl.textContent = rate + '/s';
            // Reset every 10s
            if (elapsed > 10) {
                perf.domWriteCount = 0;
                perf.lastDomResetTime = now;
            }
        }
        if (frameEl) frameEl.textContent = perf.avgFrameTime.toFixed(1) + 'ms';
    }

    // ====== CONSOLE.LOG THROTTLE ======
    // In production, suppress repetitive logs to reduce DevTools overhead
    const _logCounts = {};
    const _origLog = console.log;
    const _origWarn = console.warn;

    console.log = function (...args) {
        const key = String(args[0]).substring(0, 40);
        _logCounts[key] = (_logCounts[key] || 0) + 1;
        // Allow first 3, then every 10th
        if (_logCounts[key] <= 3 || _logCounts[key] % 10 === 0) {
            _origLog.apply(console, args);
        }
    };

    console.warn = function (...args) {
        const key = String(args[0]).substring(0, 40);
        _logCounts[key] = (_logCounts[key] || 0) + 1;
        if (_logCounts[key] <= 3 || _logCounts[key] % 10 === 0) {
            _origWarn.apply(console, args);
        }
    };

    // Reset log counts every 60s to prevent the _logCounts object from growing unbounded
    setInterval(() => {
        for (const key in _logCounts) delete _logCounts[key];
    }, 60000);

    // ====== STARTUP METRICS ======
    // Measure and report page load performance
    window.addEventListener('load', () => {
        setTimeout(() => {
            const navTiming = performance.getEntriesByType('navigation')[0];
            if (navTiming) {
                console.log(`[PERF] Page Load: ${Math.round(navTiming.loadEventEnd - navTiming.fetchStart)}ms`);
                console.log(`[PERF] DOM Interactive: ${Math.round(navTiming.domInteractive - navTiming.fetchStart)}ms`);
                console.log(`[PERF] DOM Complete: ${Math.round(navTiming.domComplete - navTiming.fetchStart)}ms`);
            }
            // Start periodic metrics
            measureLatency();
            updateSharpe();
        }, 1000);
    });

    // Periodic metrics update (every 10s) — single interval, fixed
    setInterval(() => {
        measureLatency();
        updateSharpe();
    }, 10000);

    // Expose for debugging
    window._perf = perf;

    console.log('[PERF] Performance Engine loaded');
})();
