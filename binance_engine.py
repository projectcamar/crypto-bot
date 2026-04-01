"""
Binance Trading Engine
Background engine for real-time price tracking, signal generation, and auto-trade execution.
"""

import time
import threading
import json
import requests

# ============================================================
# Engine State
# ============================================================
ENGINE_STATE = {
    "enabled": False,
    "mode": "manual",          # manual | auto_scalp | auto_ema | auto_grid
    "symbol": "BTCUSDT",
    "config": {
        "betSize": 10,         # USDT per trade
        "takeProfit": 0.5,     # % TP
        "stopLoss": 0.3,       # % SL
        "maxOpenTrades": 3,
        "emaFast": 9,
        "emaSlow": 21,
    },
    "position": None,          # Current position if any
    "signals": [],             # Recent signals
    "logs": [],
    "prices": {},              # symbol -> latest price
    "priceHistory": {},        # symbol -> [price, price, ...]
    "indicators": {},          # symbol -> {ema9, ema21, rsi14, ...}
}
ENGINE_LOCK = threading.Lock()

# ============================================================
# Logging
# ============================================================
def add_log(msg, level="info"):
    with ENGINE_LOCK:
        ENGINE_STATE["logs"].append({
            "time": time.time(),
            "msg": msg,
            "level": level
        })
        if len(ENGINE_STATE["logs"]) > 100:
            ENGINE_STATE["logs"].pop(0)
    print(f"[ENGINE] {msg}")

# ============================================================
# Technical Indicators
# ============================================================
def calc_ema(prices, period):
    """Calculate EMA from price list."""
    if len(prices) < period:
        return None
    multiplier = 2 / (period + 1)
    ema = sum(prices[:period]) / period  # SMA for initial
    for price in prices[period:]:
        ema = (price - ema) * multiplier + ema
    return ema

def calc_rsi(prices, period=14):
    """Calculate RSI from price list."""
    if len(prices) < period + 1:
        return None
    
    gains = []
    losses = []
    for i in range(1, len(prices)):
        diff = prices[i] - prices[i-1]
        gains.append(max(0, diff))
        losses.append(max(0, -diff))
    
    if len(gains) < period:
        return None
    
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    
    if avg_loss == 0:
        return 100
    
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))

def update_indicators(symbol, prices):
    """Update all indicators for a symbol."""
    with ENGINE_LOCK:
        ENGINE_STATE["indicators"][symbol] = {
            "ema9": calc_ema(prices, 9),
            "ema21": calc_ema(prices, 21),
            "ema50": calc_ema(prices, 50),
            "rsi14": calc_rsi(prices, 14),
            "price": prices[-1] if prices else 0,
            "updated": time.time()
        }

# ============================================================
# Price Tracking Loop
# ============================================================
def price_tracker_loop():
    """Tracks prices via REST polling every 1s."""
    add_log("Price Tracker STARTED")
    
    while True:
        if not ENGINE_STATE["enabled"]:
            time.sleep(1)
            continue
        
        try:
            symbol = ENGINE_STATE["symbol"]
            # Fetch recent klines (1m) for indicator calculation
            r = requests.get(
                f"https://api.binance.com/api/v3/klines",
                params={"symbol": symbol, "interval": "1m", "limit": "60"},
                timeout=5
            )
            if r.status_code == 200:
                klines = r.json()
                close_prices = [float(k[4]) for k in klines]
                
                with ENGINE_LOCK:
                    ENGINE_STATE["prices"][symbol] = close_prices[-1] if close_prices else 0
                    ENGINE_STATE["priceHistory"][symbol] = close_prices
                
                update_indicators(symbol, close_prices)
            
        except Exception as e:
            add_log(f"Price Tracker Error: {e}", "error")
        
        time.sleep(1)

# ============================================================
# Signal Generation
# ============================================================
def check_ema_crossover(symbol):
    """Check for EMA crossover signal."""
    indicators = ENGINE_STATE.get("indicators", {}).get(symbol, {})
    ema_fast = indicators.get("ema9")
    ema_slow = indicators.get("ema21")
    
    if ema_fast is None or ema_slow is None:
        return None
    
    if ema_fast > ema_slow:
        return {"type": "EMA_CROSS", "direction": "BUY", "strength": abs(ema_fast - ema_slow)}
    elif ema_fast < ema_slow:
        return {"type": "EMA_CROSS", "direction": "SELL", "strength": abs(ema_fast - ema_slow)}
    return None

def check_rsi_signal(symbol):
    """Check for RSI overbought/oversold signal."""
    indicators = ENGINE_STATE.get("indicators", {}).get(symbol, {})
    rsi = indicators.get("rsi14")
    
    if rsi is None:
        return None
    
    if rsi < 30:
        return {"type": "RSI_OVERSOLD", "direction": "BUY", "rsi": rsi}
    elif rsi > 70:
        return {"type": "RSI_OVERBOUGHT", "direction": "SELL", "rsi": rsi}
    return None

# ============================================================
# Auto-Trade Decision Loop
# ============================================================
def decision_loop():
    """Main decision loop for auto-trading."""
    add_log("Decision Loop STARTED")
    
    while True:
        with ENGINE_LOCK:
            if not ENGINE_STATE["enabled"] or ENGINE_STATE["mode"] == "manual":
                pass  # Still loop, just don't trade
            else:
                symbol = ENGINE_STATE["symbol"]
                mode = ENGINE_STATE["mode"]
                
                # Check signals
                ema_signal = check_ema_crossover(symbol)
                rsi_signal = check_rsi_signal(symbol)
                
                signals = []
                if ema_signal:
                    signals.append(ema_signal)
                if rsi_signal:
                    signals.append(rsi_signal)
                
                ENGINE_STATE["signals"] = signals
                
                # Position management
                if ENGINE_STATE["position"]:
                    pos = ENGINE_STATE["position"]
                    current_price = ENGINE_STATE["prices"].get(symbol, 0)
                    if current_price > 0 and pos.get("entryPrice", 0) > 0:
                        pnl_pct = ((current_price - pos["entryPrice"]) / pos["entryPrice"]) * 100
                        if pos["side"] == "SELL":
                            pnl_pct = -pnl_pct
                        
                        tp = ENGINE_STATE["config"].get("takeProfit", 0.5)
                        sl = ENGINE_STATE["config"].get("stopLoss", 0.3)
                        
                        if pnl_pct >= tp:
                            add_log(f"💰 TP HIT: {pnl_pct:.2f}% >= {tp}%", "success")
                            ENGINE_STATE["position"]["closeReason"] = "TP"
                        elif pnl_pct <= -sl:
                            add_log(f"🚨 SL HIT: {pnl_pct:.2f}% <= -{sl}%", "error")
                            ENGINE_STATE["position"]["closeReason"] = "SL"
        
        time.sleep(0.5)  # 500ms decision cycle

# ============================================================
# Engine Control
# ============================================================
_threads_started = False

def start_engine():
    """Start the trading engine."""
    global _threads_started
    with ENGINE_LOCK:
        ENGINE_STATE["enabled"] = True
    
    if not _threads_started:
        threading.Thread(target=price_tracker_loop, daemon=True).start()
        threading.Thread(target=decision_loop, daemon=True).start()
        _threads_started = True
    
    add_log("Engine STARTED")

def stop_engine():
    """Stop the trading engine."""
    with ENGINE_LOCK:
        ENGINE_STATE["enabled"] = False
    add_log("Engine STOPPED")

def get_engine_status():
    """Get current engine status."""
    with ENGINE_LOCK:
        return {
            "enabled": ENGINE_STATE["enabled"],
            "mode": ENGINE_STATE["mode"],
            "symbol": ENGINE_STATE["symbol"],
            "config": ENGINE_STATE["config"],
            "position": ENGINE_STATE["position"],
            "signals": ENGINE_STATE["signals"],
            "indicators": ENGINE_STATE["indicators"],
            "prices": ENGINE_STATE["prices"],
            "logs": ENGINE_STATE["logs"][-20:]  # Last 20 logs
        }

def update_engine_config(new_config):
    """Update engine configuration."""
    with ENGINE_LOCK:
        if "mode" in new_config:
            ENGINE_STATE["mode"] = new_config["mode"]
        if "symbol" in new_config:
            ENGINE_STATE["symbol"] = new_config["symbol"]
        if "config" in new_config:
            ENGINE_STATE["config"].update(new_config["config"])
        if "enabled" in new_config:
            ENGINE_STATE["enabled"] = new_config["enabled"]
    
    add_log(f"Config Updated: mode={ENGINE_STATE['mode']}, symbol={ENGINE_STATE['symbol']}")
