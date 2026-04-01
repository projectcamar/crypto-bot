import asyncio
import websockets
import json
import time
import threading
import traceback

# Shared State
HFT_STATE = {
    "enabled": False,
    "strategy": "Manual",
    "config": {},
    "market": None,
    "livePrice": 0,
    "currentBet": None,
    "balance": 0,
    "logs": []
}
HFT_LOCK = threading.Lock()

def add_log(msg):
    with HFT_LOCK:
        HFT_STATE["logs"].append({"time": time.time(), "msg": msg})
        if len(HFT_STATE["logs"]) > 50:
            HFT_STATE["logs"].pop(0)
    print(f"[HFT] {msg}")

async def binance_ws_loop():
    uri = "wss://stream.binance.com:9443/ws/btcusdt@trade"
    while HFT_STATE["enabled"]:
        try:
            async with websockets.connect(uri) as websocket:
                add_log("Binance WS Connected.")
                async for message in websocket:
                    if not HFT_STATE["enabled"]:
                        break
                    data = json.loads(message)
                    with HFT_LOCK:
                        HFT_STATE["livePrice"] = float(data["p"])
        except Exception as e:
            add_log(f"Binance WS Error: {e}")
            await asyncio.sleep(2)

def hft_decision_loop():
    """ The core 50ms decision loop running in a background thread """
    import requests
    add_log("HFT Decision Loop Started.")
    
    last_decision = 0
    while True:
        with HFT_LOCK:
            if not HFT_STATE["enabled"]:
                time.sleep(1)
                continue
                
            config = HFT_STATE["config"]
            market = HFT_STATE["market"]
            
        if not market:
            time.sleep(0.5)
            continue
            
        now = time.time()
        if now - last_decision >= 0.05: # 50ms Ultra-Fast Loop
            last_decision = now
            
            # 1. Stale Guard & Configuration
            if config.get("minBuyPrice", {}).get("enabled"):
                min_buy = config["minBuyPrice"]["value"]
            else:
                min_buy = 0
                
            if config.get("maxBuyPrice", {}).get("enabled"):
                max_buy = config["maxBuyPrice"]["value"]
            else:
                max_buy = 1000000 # Default high for price
                
            live_price = HFT_STATE["livePrice"]
            # Decision logic for Binance-only trading goes here
            
        time.sleep(0.01) # 10ms rest

_loop_thread = None

def start_hft():
    global _loop_thread
    with HFT_LOCK:
        if HFT_STATE["enabled"]:
            return
        HFT_STATE["enabled"] = True
    
    _loop_thread = threading.Thread(target=hft_decision_loop, daemon=True)
    _loop_thread.start()
    add_log("HFT Engine Activated.")

def stop_hft():
    with HFT_LOCK:
        HFT_STATE["enabled"] = False
    add_log("HFT Engine Deactivated.")

def update_config(new_cfg):
    with HFT_LOCK:
        HFT_STATE["config"] = new_cfg.get("config", {})
        HFT_STATE["market"] = new_cfg.get("market", None)
        HFT_STATE["strategy"] = new_cfg.get("strategy", "Manual")
        
    add_log(f"Config Synced. Strategy: {HFT_STATE['strategy']}")

def get_hft_status():
    with HFT_LOCK:
        return {
            "enabled": HFT_STATE["enabled"],
            "strategy": HFT_STATE["strategy"],
            "livePrice": HFT_STATE["livePrice"],
            "logs": HFT_STATE["logs"]
        }
