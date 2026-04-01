/**
 * poll_worker.js
 * Handle background polling for Trading bot.
 * This runs in a separate thread to avoid browser tab throttling.
 */

let marketTimer = null;
let priceTimer = null;
let uiTimer = null;

self.onmessage = function (e) {
    if (e.data === 'start') {
        console.log("👷 Poll Worker: Starting timers...");

        // 1. Fetch Market Data every 2 seconds
        if (!marketTimer) {
            marketTimer = setInterval(() => {
                self.postMessage('fetchMarket');
            }, 2000);
        }

        // 2. Fetch Market Prices every 500ms (High Frequency)
        if (!priceTimer) {
            priceTimer = setInterval(() => {
                self.postMessage('fetchPrices');
            }, 500);
        }

        // 3. Update UI Timer/Countdown/Strategy every 200ms (High Speed)
        if (!uiTimer) {
            uiTimer = setInterval(() => {
                self.postMessage('updateTimer');
            }, 200);
        }
    } else if (e.data === 'stop') {
        console.log("👷 Poll Worker: Stopping timers...");
        clearInterval(marketTimer);
        clearInterval(priceTimer);
        clearInterval(uiTimer);
        marketTimer = null;
        priceTimer = null;
        uiTimer = null;
    }
};
