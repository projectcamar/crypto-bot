"""
Binance Trading Bot — Python Backend Server
Flask-based server providing REST API endpoints for the Binance trading dashboard.
"""

import json
import sys
import codecs
import os
import time
import threading
import hmac
import hashlib
from urllib.parse import urlencode

if sys.platform.startswith('win'):
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')

import sys
import os
import json
import time
import uuid
import datetime
import threading
import requests
import asyncio
import websockets
import ssl
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
from flask_cors import CORS
import pandas as pd
import pandas_ta as ta
from backtesting import Backtest, Strategy

# ============================================================
# BINANCE API CREDENTIALS (LOADED FROM .ENV)
# ============================================================
def load_env():
    """Manual .env loader to avoid external dependencies."""
    if os.path.exists('.env'):
        with open('.env') as f:
            for line in f:
                if '=' in line and not line.strip().startswith('#'):
                    key, value = line.strip().split('=', 1)
                    os.environ[key.strip()] = value.strip()

load_env()

BINANCE_API_KEY = os.environ.get("BINANCE_API_KEY", "")
BINANCE_SECRET_KEY = os.environ.get("BINANCE_SECRET_KEY", "")

if not BINANCE_API_KEY or not BINANCE_SECRET_KEY:
    print("⚠️ WARNING: Binance API keys not found in .env file!")

# Base URLs — Try mirrors if main domain has SSL issues (common w/ ISP interception)
BINANCE_MIRRORS = [
    "https://data-api.binance.vision",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api.binance.com",
]
BINANCE_BASE = BINANCE_MIRRORS[0]  # Start with data-api
BINANCE_FAPI = "https://fapi.binance.com"  # Futures

# ============================================================
# HTTP Session with Connection Pooling
# ============================================================
API_SESSION = requests.Session()
API_SESSION.headers.update({
    'User-Agent': 'BinanceBot/1.0',
    'Accept': 'application/json',
    'X-MBX-APIKEY': BINANCE_API_KEY
})
API_SESSION.verify = False  # Bypass SSL verification (ISP HTTPS interception fix)
adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=32, max_retries=2)
API_SESSION.mount('https://', adapter)
API_SESSION.mount('http://', adapter)

# --- DNS-over-HTTPS Resolver (bypass ISP DNS hijacking) ---
import socket
_original_getaddrinfo = socket.getaddrinfo
_dns_cache = {}

def _resolve_via_doh(hostname):
    """Resolve hostname using Cloudflare DNS-over-HTTPS to bypass ISP DNS poisoning."""
    if hostname in _dns_cache:
        print(f"🌐 (Cache) DNS resolved {hostname} -> {_dns_cache[hostname]}")
        return _dns_cache[hostname]
    try:
        r = requests.get(
            f'https://1.1.1.1/dns-query?name={hostname}&type=A',
            headers={'Accept': 'application/dns-json'},
            timeout=5,
            verify=False
        )
        if r.status_code == 200:
            data = r.json()
            for answer in data.get('Answer', []):
                if answer.get('type') == 1:  # A record
                    ip = answer['data']
                    _dns_cache[hostname] = ip
                    print(f"🌐 (DoH) DNS resolved {hostname} -> {ip}")
                    return ip
    except Exception as e:
        print(f"⚠️ DoH resolution failed for {hostname}: {e}")
    return None

def _patched_getaddrinfo(host, port, *args, **kwargs):
    """Patched getaddrinfo that uses DoH for Binance domains."""
    binance_domains = ['api.binance.com', 'api1.binance.com', 'api2.binance.com',
                       'api3.binance.com', 'api4.binance.com', 'fapi.binance.com',
                       'fstream.binance.com', 'fstream3.binance.com',
                       'stream.binance.com', 'data-api.binance.vision']
    if host in binance_domains:
        ip = _resolve_via_doh(host)
        if ip:
            results = _original_getaddrinfo(ip, port, *args, **kwargs)
            return results
    return _original_getaddrinfo(host, port, *args, **kwargs)

socket.getaddrinfo = _patched_getaddrinfo
print("🌐 DNS-over-HTTPS resolver enabled (bypasses ISP DNS poisoning)")

# Auto-detect working Binance mirror
def find_working_mirror():
    global BINANCE_BASE
    print("🔍 Searching for working Binance mirror...")
    for mirror in BINANCE_MIRRORS:
        try:
            r = API_SESSION.get(f"{mirror}/api/v3/ping", timeout=3)
            if r.status_code == 200:
                BINANCE_BASE = mirror
                print(f"✅ Using Binance mirror: {mirror}")
                return mirror
        except Exception as e:
            print(f"⚠️ Mirror {mirror} failed: {e}")
    print("❌ All Binance mirrors failed! Check your internet connection.")
    return BINANCE_MIRRORS[0]

# Only run side-effects if not on Vercel
if not os.environ.get('VERCEL'):
    find_working_mirror()

# ============================================================
# Binance API Signing Helper
# ============================================================
def sign_request(params: dict) -> dict:
    """Add timestamp and HMAC-SHA256 signature to request params."""
    params['timestamp'] = int(time.time() * 1000)
    query_string = urlencode(params)
    signature = hmac.new(
        BINANCE_SECRET_KEY.encode('utf-8'),
        query_string.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    params['signature'] = signature
    return params

def binance_get(endpoint, params=None, signed=False):
    """Make a GET request to Binance API."""
    if params is None:
        params = {}
    url = f"{BINANCE_BASE}{endpoint}"
    if signed:
        params = sign_request(params)
    try:
        r = API_SESSION.get(url, params=params, timeout=10)
        return r.json(), r.status_code
    except Exception as e:
        return {"error": str(e)}, 500

def binance_post(endpoint, params=None, signed=True):
    """Make a POST request to Binance API."""
    if params is None:
        params = {}
    url = f"{BINANCE_BASE}{endpoint}"
    if signed:
        params = sign_request(params)
    try:
        r = API_SESSION.post(url, params=params, timeout=10)
        return r.json(), r.status_code
    except Exception as e:
        return {"error": str(e)}, 500

def binance_delete(endpoint, params=None, signed=True):
    """Make a DELETE request to Binance API."""
    if params is None:
        params = {}
    url = f"{BINANCE_BASE}{endpoint}"
    if signed:
        params = sign_request(params)
    try:
        r = API_SESSION.delete(url, params=params, timeout=10)
        return r.json(), r.status_code
    except Exception as e:
        return {"error": str(e)}, 500

def futures_get(endpoint, params=None, signed=False):
    """Make a GET request to Binance Futures API."""
    if params is None:
        params = {}
    url = f"{BINANCE_FAPI}{endpoint}"
    if signed:
        params = sign_request(params)
    try:
        r = API_SESSION.get(url, params=params, timeout=10)
        return r.json(), r.status_code
    except Exception as e:
        return {"error": str(e)}, 500

def futures_post(endpoint, params=None, signed=True):
    """Make a POST request to Binance Futures API."""
    if params is None:
        params = {}
    
    # Ensure booleans are lowercase strings
    for k, v in params.items():
        if v is True or v == 'True': params[k] = 'true'
        if v is False or v == 'False': params[k] = 'false'

    url = f"{BINANCE_FAPI}{endpoint}"
    if signed:
        params = sign_request(params)
    
    try:
        # Move parameters to the body (data=params) instead of URL (params=params)
        # for better compatibility with certain order types.
        print(f"📡 [POST] {url} | Params: {json.dumps(params)}")
        r = API_SESSION.post(url, data=params, timeout=10)
        
        # Log response for debugging
        if r.status_code != 200:
            print(f"❌ [POST ERROR] {r.status_code} | Response: {r.text}")
            
        return r.json(), r.status_code
    except Exception as e:
        print(f"❌ [POST EXCEPTION] {str(e)}")
        return {"error": str(e)}, 500


# ============================================================
# Live Price State (Updated by background thread)
# ============================================================
PRICE_DATA = {
    "prices": {},       # symbol -> price
    "tickers": {},      # symbol -> 24h ticker data
    "premium": {},      # symbol -> funding & mark
    "watchlist": [],    # tracked user watch-list
    "lastUpdate": 0
}
PRICE_LOCK = threading.Lock()
WS_CONNECTED = False  # Flag for REST fallback optimization

def price_updater_loop():
    """Background thread for non-WS data (funding rates, etc.) 
       and REST fallback for prices."""
    print("🌐 Price Updater (REST Fallback/Funding) STARTED", flush=True)

    def fetch_market_data():
        global WS_CONNECTED
        try:
            # 1. Fetch Premium Index (Funding Rates) all at once
            r_prem = API_SESSION.get(f"{BINANCE_FAPI}/fapi/v1/premiumIndex", timeout=10)
            if r_prem.status_code == 200:
                all_prem = r_prem.json()
                with PRICE_LOCK:
                    for p in all_prem:
                        sym = p.get("symbol", "")
                        if sym.endswith("USDT"):
                            PRICE_DATA["premium"][sym] = {
                                "markPrice": float(p.get("markPrice", 0)),
                                "lastFundingRate": float(p.get("lastFundingRate", 0)),
                                "nextFundingTime": p.get("nextFundingTime", 0)
                            }

            # 2. REST FALLBACK: If WS is not connected, fetch all 24h tickers to keep UI alive
            if not WS_CONNECTED:
                r_tickers = API_SESSION.get(f"{BINANCE_FAPI}/fapi/v1/ticker/24hr", timeout=10)
                if r_tickers.status_code == 200:
                    all_tickers = r_tickers.json()
                    with PRICE_LOCK:
                        for t in all_tickers:
                            sym = t["symbol"]
                            if sym.endswith("USDT"):
                                price = float(t["lastPrice"])
                                PRICE_DATA["prices"][sym] = price
                                PRICE_DATA["tickers"][sym] = {
                                    "price": price,
                                    "changePercent": float(t["priceChangePercent"]),
                                    "high": float(t["highPrice"]),
                                    "low": float(t["lowPrice"]),
                                    "volume": float(t["volume"]),
                                    "quoteVolume": float(t["quoteVolume"]),
                                    "isFuture": True
                                }
            
            with PRICE_LOCK:
                PRICE_DATA["lastUpdate"] = time.time()
        except Exception as e:
            print(f"⚠️ Rest Update Error: {e}", flush=True)

    while True:
        try:
            fetch_market_data()
        except Exception as e:
            print(f"⚠️ Rest Loop Error: {e}", flush=True)
        
        # Frequency depends on urgency - Mark price/funding is critical
        # MOD: Reduced to 2s for smoother REST fallback
        time.sleep(2)

# ============================================================
# CENTRALIZED WEB-SOCKET PROXY (Binance -> Backend -> Frontend)
# ============================================================
ACTIVE_SYMBOLS = set(["RIVERUSDT"]) # Default active symbols to track deeply
ACTIVE_TFS = set(["1m", "5m"]) # Track relevant timeframes
SSE_CLIENTS = [] # List of queues for active SSE connections

async def binance_ws_proxy():
    """Main background task that connects to Binance and updates PRICE_DATA."""
    global WS_CONNECTED
    uri = "wss://fstream.binance.com/stream?streams=!ticker@arr"
    
    while True:
        try:
            def build_streams():
                s = []
                for sym in list(ACTIVE_SYMBOLS):
                    s.append(f"{sym.lower()}@depth10@100ms")
                    s.append(f"{sym.lower()}@aggTrade")
                    s.append(f"{sym.lower()}@markPrice@1s")
                    for tf in list(ACTIVE_TFS):
                        # Binance Futures does not support 1s/3s/5s kline streams for most pairs.
                        # These are handled via aggTrade on the frontend anyway.
                        if not tf.endswith('s'):
                            s.append(f"{sym.lower()}@kline_{tf}")
                return set(s)

            current_streams = build_streams()
            subscribe_msg = {
                "method": "SUBSCRIBE",
                "params": list(current_streams),
                "id": 1
            }

            # Use a custom SSL context that bypasses verification to handle ISP/Proxy issues
            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE

            async with websockets.connect(uri, ssl=ssl_context) as websocket:
                WS_CONNECTED = True # TCP Connection established
                if current_streams:
                    await websocket.send(json.dumps({"method": "SUBSCRIBE", "params": list(current_streams), "id": 1}))
                print(f"📡 Central WS Hub: Connected via {uri}", flush=True)

                last_streams = current_streams

                async for message in websocket:
                    # Dynamic Subscription Check
                    new_streams = build_streams()
                    if new_streams != last_streams:
                        to_sub = list(new_streams - last_streams)
                        to_unsub = list(last_streams - new_streams)
                        if to_sub:
                            await websocket.send(json.dumps({"method": "SUBSCRIBE", "params": to_sub, "id": int(time.time())}))
                        if to_unsub:
                            await websocket.send(json.dumps({"method": "UNSUBSCRIBE", "params": to_unsub, "id": int(time.time())}))
                        last_streams = new_streams
                        print(f"🔄 Central WS Hub: Updated Subscriptions (+{len(to_sub)}, -{len(to_unsub)})")

                    WS_CONNECTED = True 
                    data = json.loads(message)
                    if "stream" in data:
                        stream_type = data["stream"]
                        payload = data["data"]
                        
                        event_data = None
                        
                        # Process 24h Ticker Array
                        if stream_type == "!ticker@arr":
                            # THROTTLE: Only update PRICE_DATA and broadcast every 1s
                            now = time.time()
                            if not hasattr(binance_ws_proxy, "last_ticker_time"):
                                binance_ws_proxy.last_ticker_time = 0
                            
                            if now - binance_ws_proxy.last_ticker_time >= 1.0:
                                with PRICE_LOCK:
                                    for t in payload:
                                        sym = t["s"]
                                        if sym.endswith("USDT"):
                                            price = float(t["c"])
                                            PRICE_DATA["prices"][sym] = price
                                            PRICE_DATA["tickers"][sym] = {
                                                "price": price,
                                                "changePercent": float(t["P"]),
                                                "high": float(t["h"]),
                                                "low": float(t["l"]),
                                                "volume": float(t["v"]),
                                                "quoteVolume": float(t["q"]),
                                                "isFuture": True
                                            }
                                event_data = {
                                    "type": "ticker_all",
                                    "prices": PRICE_DATA["prices"],
                                    "tickers": PRICE_DATA["tickers"]
                                }
                                binance_ws_proxy.last_ticker_time = now
                            else:
                                continue # Skip broadcasting to FE

                        # Process Individual Depth (@depth10@100ms)
                        elif "@depth" in stream_type:
                            # We don't necessarily update PRICE_DATA for book (too heavy)
                            # But we pass it immediately to SSE clients
                            event_data = {"type": "depth", "symbol": payload["s"], "data": payload}

                        # Process Individual Trades (@aggTrade)
                        elif "@aggTrade" in stream_type:
                            event_data = {"type": "aggTrade", "symbol": payload["s"], "price": payload["p"], "qty": payload["q"], "time": payload["T"], "m": payload["m"]}

                        # Process Klines (@kline)
                        elif "@kline" in stream_type:
                            event_data = {"type": "kline", "symbol": payload["s"], "interval": payload["k"]["i"], "data": payload["k"]}

                        # Process Mark Price (@markPrice)
                        elif "@markPrice" in stream_type:
                            sym = payload["s"]
                            with PRICE_LOCK:
                                PRICE_DATA["premium"][sym] = {
                                    "markPrice": float(payload["p"]),
                                    "indexPrice": float(payload["i"]),
                                    "lastFundingRate": float(payload["r"]),
                                    "nextFundingTime": payload["T"]
                                }
                            # Broadcast to FE immediately for real-time Mark Price updates
                            event_data = {
                                "type": "mark_price",
                                "symbol": sym,
                                "data": PRICE_DATA["premium"][sym]
                            }

                        # Broadcast to all connected FE clients via SSE
                        if event_data:
                            msg = f"data: {json.dumps(event_data)}\n\n"
                            for client_queue in list(SSE_CLIENTS):
                                try:
                                    client_queue.put_nowait(msg)
                                except:
                                    pass

        except Exception as e:
            WS_CONNECTED = False
            print(f"⚠️ Central WS Hub Error: {e}. Reconnecting in 5s...", flush=True)
            await asyncio.sleep(5)

import queue

def start_async_loop(loop):
    """Sets the event loop and runs the Binance WS proxy."""
    asyncio.set_event_loop(loop)
    loop.run_until_complete(binance_ws_proxy())

if not os.environ.get('VERCEL'):
    # Initialize the async loop in a separate thread for the Central WS Hub
    try:
        ws_loop = asyncio.new_event_loop()
        threading.Thread(target=start_async_loop, args=(ws_loop,), daemon=True).start()
    except Exception as e:
        print(f"⚠️ Failed to start background WS loop: {e}")


# ============================================================
# Flask Application
# ============================================================
app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# --- Static Files ---
@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory('.', filename)

# --- API: Market Stream (SSE) ---
@app.route('/api/stream/market')
def api_stream_market():
    def event_stream():
        q = queue.Queue(maxsize=1000)
        SSE_CLIENTS.append(q)
        print(f"🔌 SSE Client Connected. Total: {len(SSE_CLIENTS)}", flush=True)
        try:
            # Initial seed: send ALL current prices immediately on connect
            with PRICE_LOCK:
                seed_data = {"type": "ticker_all", "prices": PRICE_DATA["prices"]}
                yield f"data: {json.dumps(seed_data)}\n\n"
            
            while True:
                msg = q.get() # Blocking get
                yield msg
        except GeneratorExit:
            try:
                SSE_CLIENTS.remove(q)
            except ValueError:
                pass  # Already removed, safe to ignore
            print(f"❌ SSE Client Disconnected. Remaining: {len(SSE_CLIENTS)}", flush=True)
        except Exception as e:
            try:
                SSE_CLIENTS.remove(q)
            except ValueError:
                pass
            print(f"⚠️ SSE Client Error (cleaned up): {e}. Remaining: {len(SSE_CLIENTS)}", flush=True)

    return Response(stream_with_context(event_stream()), mimetype="text/event-stream")

@app.route('/api/status')
def api_status():
    is_serverless = bool(os.environ.get('VERCEL'))
    keys_ready = (BINANCE_SECRET_KEY != "YOUR_SECRET_KEY_HERE" and len(BINANCE_SECRET_KEY) > 10)
    return jsonify({
        "connected": WS_CONNECTED,
        "ws_connected": WS_CONNECTED,
        "api_ready": keys_ready,
        "serverless": is_serverless
    })

@app.route('/api/active-symbol', methods=['POST'])
def api_active_symbol():
    """Tells the backend to focus its deep 100ms stream on this symbol and timeframes."""
    data = request.json
    sym = data.get("symbol")
    tf = data.get("interval")
    htf = data.get("hedgeInterval") # Optional second TF
    
    dirty = False
    if sym and sym not in ACTIVE_SYMBOLS:
        ACTIVE_SYMBOLS.add(sym)
        dirty = True
    if tf and tf not in ACTIVE_TFS:
        ACTIVE_TFS.add(tf)
        dirty = True
    if htf and htf not in ACTIVE_TFS:
        ACTIVE_TFS.add(htf)
        dirty = True
        
    if dirty:
        # Keep management simple: if we have too many, reset
        if len(ACTIVE_SYMBOLS) > 10: ACTIVE_SYMBOLS.clear(); ACTIVE_SYMBOLS.add(sym)
        if len(ACTIVE_TFS) > 10: ACTIVE_TFS.clear(); ACTIVE_TFS.add(tf); ACTIVE_TFS.add(htf) if htf else None
        print(f"🎯 Active Context updated: {sym} | TFs: {ACTIVE_TFS}", flush=True)
        # Push immediate update for Mark Price to SSE clients if we have it
        with PRICE_LOCK:
            if sym in PRICE_DATA["premium"]:
                msg = f"data: {json.dumps({'type': 'mark_price', 'symbol': sym, 'data': PRICE_DATA['premium'][sym]})}\n\n"
                for q in list(SSE_CLIENTS):
                    try: q.put_nowait(msg)
                    except: pass
        
    return jsonify({"status": "ok"})

# --- API: Account Balance ---
@app.route('/api/balance')
def api_balance():
    # Use Futures account endpoint (/fapi/v2/account)
    data, status = futures_get('/fapi/v2/account', signed=True)
    if status != 200:
        return jsonify(data), status

    balances = []
    total_usdt = 0
    unrealized_pnl = float(data.get('totalUnrealizedProfit', 0))
    # Futures API uses 'assets' instead of 'balances'
    for a in data.get('assets', []):
        m_balance = float(a['marginBalance'])
        w_balance = float(a['walletBalance'])
        if m_balance > 0 or w_balance > 0:
            balances.append({
                "asset": a['asset'],
                "free": float(a['availableBalance']),
                "locked": w_balance - float(a['availableBalance']),
                "total": w_balance,
                "marginBalance": m_balance,
                "type": "FUTURES"
            })
            if a['asset'] == 'USDT':
                total_usdt += w_balance

    # Fetch Spot Balances
    spot_data, spot_status = binance_get('/api/v3/account', signed=True)
    if spot_status == 200:
        for a in spot_data.get('balances', []):
            free = float(a['free'])
            locked = float(a['locked'])
            total = free + locked
            if total > 0:
                balances.append({
                    "asset": a['asset'],
                    "free": free,
                    "locked": locked,
                    "total": total,
                    "marginBalance": total, # Spot doesn't have marginBalance
                    "type": "SPOT"
                })
                if a['asset'] == 'USDT':
                    total_usdt += total
                    
    # Sort balances so USDT is at the top, then by total descending
    def sort_key(b):
        if b['asset'] == 'USDT':
            return 1000000000 + b['total']
        return b['total']
    
    balances.sort(key=sort_key, reverse=True)

    return jsonify({
        "totalUSDT": total_usdt,
        "unrealizedPnL": unrealized_pnl,
        "balances": balances,
        "canTrade": data.get('canTrade', False),
        "canWithdraw": data.get('canWithdraw', False)
    })

# --- API: Live Prices ---
@app.route('/api/prices')
def api_prices():
    with PRICE_LOCK:
        return jsonify({
            "prices": PRICE_DATA["prices"],
            "tickers": PRICE_DATA["tickers"],
            "lastUpdate": PRICE_DATA["lastUpdate"],
            "watchlist": PRICE_DATA["watchlist"]
        })

# --- API: Update Watchlist ---
@app.route('/api/watchlist', methods=['POST'])
def api_watchlist():
    data = request.get_json()
    symbols = data.get('symbols', [])
    with PRICE_LOCK:
        PRICE_DATA["watchlist"] = [s.upper() for s in symbols]
    return jsonify({"ok": True, "watchlist": PRICE_DATA["watchlist"]})

# --- API: Full Screener Data ---
@app.route('/api/screener-data')
def api_screener_data():
    with PRICE_LOCK:
        result = []
        for sym, tick in PRICE_DATA["tickers"].items():
            prem = PRICE_DATA["premium"].get(sym, {})
            result.append({
                "symbol": sym,
                "price": tick["price"],
                "changePercent": tick["changePercent"],
                "volume": tick["volume"],
                "quoteVolume": tick["quoteVolume"],
                "markPrice": prem.get("markPrice", 0),
                "fundingRate": prem.get("lastFundingRate", 0),
                "fundingTime": prem.get("nextFundingTime", 0)
            })
        return jsonify(result)

# --- API: Klines (Candlesticks) ---
@app.route('/api/klines/<symbol>')
def api_klines(symbol):
    interval = request.args.get('interval', '1m')
    limit = int(request.args.get('limit', '300'))

    def get_raw_klines(sym, ival, lim, use_futures=True):
        try:
            if use_futures:
                data, status = futures_get('/fapi/v1/klines', params={"symbol": sym, "interval": ival, "limit": lim})
            else:
                data, status = binance_get('/api/v3/klines', params={"symbol": sym, "interval": ival, "limit": lim})
            
            if status == 200 and isinstance(data, list):
                return data
            print(f"⚠️ Binance Kline Error ({sym} {ival}): {data}", flush=True)
            return []
        except Exception as e:
            print(f"⚠️ get_raw_klines Exception: {e}", flush=True)
            return []

    synthetic_map = {'3s': 3, '5s': 5, '10s': 10, '15s': 15, '20s': 20, '30s': 30}
    
    if interval == '1s':
        data = get_raw_klines(symbol.upper(), '1s', limit, use_futures=False)
        status = 200 if data else 500

    elif interval in synthetic_map:
        group_size = synthetic_map[interval]
        raw_limit = limit * group_size
        if raw_limit > 1000: raw_limit = 1000
        
        data_1s = get_raw_klines(symbol.upper(), '1s', raw_limit, use_futures=False)
        data = []
        if data_1s:
            buckets = {}
            for k in data_1s:
                t_ms = k[0]
                t_sec = t_ms // 1000
                bucket_sec = (t_sec // group_size) * group_size
                bucket_ms = bucket_sec * 1000
                
                if bucket_ms not in buckets:
                    buckets[bucket_ms] = [bucket_ms, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])]
                else:
                    b = buckets[bucket_ms]
                    b[2] = max(b[2], float(k[2]))
                    b[3] = min(b[3], float(k[3]))
                    b[4] = float(k[4])
                    b[5] += float(k[5])
            
            for key in sorted(buckets.keys()):
                data.append(buckets[key])
        status = 200 if data else 500

    else:
        # Standard intervals (1m, 3m, 5m, etc)
        data = get_raw_klines(symbol.upper(), interval, limit, use_futures=True)
        # Spot Fallback: If Futures data is extremely short (common for newly listed perps)
        if len(data) < min(50, limit):
            spot_data = get_raw_klines(symbol.upper(), interval, limit, use_futures=False)
            if len(spot_data) > len(data):
                data = spot_data
        status = 200 if data else 500

    if not isinstance(data, list) or not data:
        return jsonify({"error": "No historical data available for this symbol/interval", "raw": data}), 200

    # Format for lightweight-charts
    candles = []
    for k in data:
        candles.append({
            "time": k[0] / 1000,  # ms -> seconds
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "volume": float(k[5])
        })
    return jsonify(candles)

# --- API: 24hr Ticker ---
@app.route('/api/ticker/<symbol>')
def api_ticker(symbol):
    # Use Futures endpoint
    data, status = futures_get('/fapi/v1/ticker/24hr', params={"symbol": symbol.upper()})
    if status != 200 or not isinstance(data, dict):
        return jsonify({"error": "Ticker fetch failed", "raw": data}), status
    return jsonify(data), status

# --- API: Order Book ---
@app.route('/api/orderbook/<symbol>')
def api_orderbook(symbol):
    limit = request.args.get('limit', '20')
    # Use Futures endpoint (/fapi/v1/depth)
    data, status = futures_get('/fapi/v1/depth', params={
        "symbol": symbol.upper(),
        "limit": limit
    })
    if status != 200 or not isinstance(data, dict):
        return jsonify({"error": "Orderbook fetch failed", "raw": data}), status
    return jsonify(data), status

# --- API: Recent Trades ---
@app.route('/api/recent-trades/<symbol>')
def api_recent_trades(symbol):
    limit = request.args.get('limit', '50')
    # Use Futures endpoint (/fapi/v1/trades)
    data, status = futures_get('/fapi/v1/trades', params={
        "symbol": symbol.upper(),
        "limit": limit
    })
    if status != 200 or not isinstance(data, list):
        return jsonify({"error": "Recent trades fetch failed", "raw": data}), status
    return jsonify(data), status

OI_CACHE = {}

# --- API: Detailed Market Info (Mark, Index, Funding, OI) ---
@app.route('/api/market-info/<symbol>')
def api_market_info(symbol):
    sym = symbol.upper()
    
    # 1. Premium Index is already kept fresh globally by the background price_updater_loop
    with PRICE_LOCK:
        premium_data = PRICE_DATA["premium"].get(sym, {})
    
    # 2. Open Interest: Cache for 15 seconds to prevent rate limit bans from UI polling
    oi_data = {}
    now = time.time()
    if sym in OI_CACHE and now - OI_CACHE[sym]["time"] < 15:
        oi_data = OI_CACHE[sym]["data"]
    else:
        fresh_oi, oi_status = futures_get('/fapi/v1/openInterest', params={"symbol": sym})
        if oi_status == 200:
            OI_CACHE[sym] = {"data": fresh_oi, "time": now}
            oi_data = fresh_oi

    result = {}
    result.update(premium_data)
    result.update(oi_data)
    
    return jsonify(result), 200

# --- API: Account Trades ---
@app.route('/api/my-trades/<symbol>')
def api_my_trades(symbol):
    limit = request.args.get('limit', '50')
    # Use Futures endpoint (/fapi/v1/userTrades)
    data, status = futures_get('/fapi/v1/userTrades', params={
        "symbol": symbol.upper(),
        "limit": limit
    }, signed=True)
    return jsonify(data), status

# --- API: Open Orders ---
@app.route('/api/open-orders')
def api_open_orders():
    symbol = request.args.get('symbol', None)
    params = {}
    if symbol:
        params['symbol'] = symbol.upper()
    # Use Futures endpoint (/fapi/v1/openOrders)
    data, status = futures_get('/fapi/v1/openOrders', params=params, signed=True)
    return jsonify(data), status

# --- API: All Orders ---
@app.route('/api/all-orders/<symbol>')
def api_all_orders(symbol):
    limit = request.args.get('limit', '50')
    # Use Futures endpoint (/fapi/v1/allOrders)
    data, status = futures_get('/fapi/v1/allOrders', params={
        "symbol": symbol.upper(),
        "limit": limit
    }, signed=True)
    return jsonify(data), status

# --- API: Place Order ---
@app.route('/api/order', methods=['POST'])
def api_place_order():
    data = request.get_json()
    symbol = data.get('symbol', 'BTCUSDT').upper()
    side = data.get('side', 'BUY').upper()
    order_type = data.get('type', 'MARKET').upper()
    quantity = data.get('quantity')
    price = data.get('price')
    quote_qty = data.get('quoteOrderQty')  # For market orders by USDT amount

    params = {
        "symbol": symbol,
        "side": side,
        "type": order_type,
    }

    if data.get('positionSide'):
        params['positionSide'] = data.get('positionSide').upper()

    if order_type == 'MARKET':
        if quote_qty:
            params['quoteOrderQty'] = str(quote_qty)
        elif quantity:
            params['quantity'] = str(quantity)
        else:
            return jsonify({"error": "quantity or quoteOrderQty required for MARKET orders"}), 400
    elif order_type == 'LIMIT':
        if not quantity or not price:
            return jsonify({"error": "quantity and price required for LIMIT orders"}), 400
        params['quantity'] = str(quantity)
        params['price'] = str(price)
        params['timeInForce'] = data.get('timeInForce', 'GTC')
    elif order_type == 'STOP_LOSS_LIMIT':
        params['quantity'] = str(quantity)
        params['price'] = str(price)
        params['stopPrice'] = str(data.get('stopPrice'))
        params['timeInForce'] = data.get('timeInForce', 'GTC')

    print(f"📡 [ORDER] {side} {order_type} {symbol} qty={quantity or quote_qty} price={price}")

    # Use Futures endpoint (/fapi/v1/order)
    result, status = futures_post('/fapi/v1/order', params=params)
    return jsonify(result), status

# --- API: Cancel Order ---
@app.route('/api/cancel-order', methods=['POST'])
def api_cancel_order():
    data = request.get_json()
    symbol = data.get('symbol', '').upper()
    order_id = data.get('orderId')

    if not symbol or not order_id:
        return jsonify({"error": "symbol and orderId required"}), 400

    result, status = binance_delete('/api/v3/order', params={
        "symbol": symbol,
        "orderId": order_id
    })
    print(f"🚫 [CANCEL] Order {order_id} on {symbol}: {result}")
    return jsonify(result), status

# --- API: Cancel All Orders ---
@app.route('/api/cancel-all', methods=['POST'])
def api_cancel_all():
    data = request.get_json()
    symbol = data.get('symbol', '').upper()
    if not symbol:
        return jsonify({"error": "symbol required"}), 400

    result, status = binance_delete('/api/v3/openOrders', params={"symbol": symbol})
    return jsonify(result), status

# --- API: Exchange Info (Symbol rules) ---
@app.route('/api/exchange-info')
def api_exchange_info():
    symbol = request.args.get('symbol', None)
    params = {}
    if symbol:
        params['symbol'] = symbol.upper()
    data, status = binance_get('/api/v3/exchangeInfo', params=params)
    return jsonify(data), status

# --- API: Server Time ---
@app.route('/api/time')
def api_time():
    data, status = binance_get('/api/v3/time')
    return jsonify(data), status

# ============================================================
# Futures API Endpoints
# ============================================================

@app.route('/api/futures/balance')
def api_futures_balance():
    data, status = futures_get('/fapi/v2/balance', signed=True)
    return jsonify(data), status

@app.route('/api/futures/positions')
def api_futures_positions():
    data, status = futures_get('/fapi/v2/positionRisk', signed=True)
    if status != 200:
        return jsonify(data), status
    # Filter to only show active positions
    active = [p for p in data if float(p.get('positionAmt', 0)) != 0]
    return jsonify(active)

@app.route('/api/futures/order', methods=['POST'])
def api_futures_order():
    data = request.get_json()
    
    # Pass-through all parameters from the frontend (Binance Futures API is flexible)
    params = {}
    for key, value in data.items():
        if value is not None:
            # Convert everything to string for the API request
            params[key] = str(value)

    # Ensure symbol, side, and type are uppercase as required by Binance
    if 'symbol' in params: params['symbol'] = params['symbol'].upper()
    if 'side' in params: params['side'] = params['side'].upper()
    if 'type' in params: params['type'] = params['type'].upper()

    result, status = futures_post('/fapi/v1/order', params=params)
    print(f"📡 [FUTURES] {params.get('side')} {params.get('type')} {params.get('symbol')} qty={params.get('quantity','0')} @ STOP={params.get('stopPrice','--')}")
    return jsonify(result), status

@app.route('/api/futures/leverage', methods=['POST'])
def api_futures_leverage():
    data = request.get_json()
    symbol = data.get('symbol', 'BTCUSDT').upper()
    leverage = data.get('leverage', 10)
    params = {
        "symbol": symbol,
        "leverage": int(leverage)
    }
    result, status = futures_post('/fapi/v1/leverage', params=params)
    return jsonify(result), status


@app.route('/api/futures/exchange-info')
def api_futures_exchange_info():
    data, status = futures_get('/fapi/v1/exchangeInfo')
    return jsonify(data), status

@app.route('/api/futures/position-mode')
def api_futures_position_mode():
    data, status = futures_get('/fapi/v1/positionSide/dual', signed=True)
    return jsonify(data), status

# ============================================================
# PYTHON BACKTESTING API (backtesting.py + pandas_ta)
# ============================================================

class DynamicStrategy(Strategy):
    strategy_name = 'pure_supertrend'
    enable_hedge = False
    
    def init(self):
        self.last_dir = 0
        self.is_hedging = False
        self.hedge_entry_price = 0
        self._hedge_starts = [] # Timestamps of hedge entries
        self._hedge_ends = []   # Timestamps of hedge exits
        
        # Prepare indicators
        self.pnl_saved_total = 0

    def next(self):
        # Prevent zero division / unset prices
        if self.data.Close[-1] <= 0: return

        # Load signals
        close_px = float(self.data.Close[-1])
        high_px = float(self.data.High[-1])
        low_px = float(self.data.Low[-1])
        
        # ─── HEDGE MODE (SSE Screener/Special cases) ───
        if self.enable_hedge and 'MAIN_SIG' in self.data.df.columns and 'HEDGE_SIG' in self.data.df.columns:
            main_sig = self.data.MAIN_SIG[-1]
            prev_main = self.data.MAIN_SIG[-2] if len(self.data.MAIN_SIG) > 1 else main_sig
            hedge_sig = self.data.HEDGE_SIG[-1]

            if main_sig != prev_main:
                if main_sig == 1:
                    if self.position: self.position.close()
                    self.buy()
                    self.is_hedging = False
                elif main_sig == -1:
                    if self.position: self.position.close()
                    self.sell()
                    self.is_hedging = False
                elif main_sig == 0:
                    if self.position: self.position.close()
                    self.is_hedging = False
                return

            if self.position:
                is_long = self.position.is_long
                aligned = (is_long and hedge_sig == 1) or (not is_long and hedge_sig == -1)
                if not aligned and not self.is_hedging:
                    self.hedge_entry_price = self.trades[0].entry_price
                    self._hedge_starts.append(self.data.index[-1])
                    self.position.close()
                    self.is_hedging = True
                elif aligned and self.is_hedging:
                    self._hedge_ends.append(self.data.index[-1])
                    if is_long: self.buy()
                    else: self.sell()
                    self.is_hedging = False
            return

        # ─── Standard Strategies ───
        sn = self.strategy_name
        
        # 1. Pure Parabolic SAR
        if sn == 'pure_parabolic_sar':
            if 'PSAR_DIR' in self.data.df.columns and len(self.data.PSAR_DIR) > 1:
                curr, prev = self.data.PSAR_DIR[-1], self.data.PSAR_DIR[-2]
                if prev != 1 and curr == 1:
                    if self.position: self.position.close()
                    self.buy()
                elif prev != -1 and curr == -1:
                    if self.position: self.position.close()
                    self.sell()

        # 2. Pure RSI (Always In)
        elif sn == 'pure_rsi':
            rsi, prsi = self.data.RSI[-1], self.data.RSI[-2]
            if prsi <= 30 and rsi > 30:
                if self.position: self.position.close()
                self.buy()
            elif prsi >= 70 and rsi < 70:
                if self.position: self.position.close()
                self.sell()

        # 3. Pure EMA
        elif sn == 'pure_ema':
            f, pf = self.data.EMA9[-1], self.data.EMA9[-2]
            s, ps = self.data.EMA21[-1], self.data.EMA21[-2]
            if pf <= ps and f > s:
                if self.position: self.position.close()
                self.buy()
            elif pf >= ps and f < s:
                if self.position: self.position.close()
                self.sell()

        # 4. Pure RSI + EMA (Always In)
        elif sn == 'pure_rsi_ema':
            rsi, prsi = self.data.RSI[-1], self.data.RSI[-2]
            f, s = self.data.EMA9[-1], self.data.EMA21[-1]
            if prsi <= 30 and rsi > 30 and f > s:
                if self.position: self.position.close()
                self.buy()
            elif prsi >= 70 and rsi < 70 and f < s:
                if self.position: self.position.close()
                self.sell()

        # 5. SuperTrend (Scalp/Pure)
        elif sn in ('pure_supertrend', 'supertrend_scalp'):
            curr, prev = self.data.ST_DIR[-1], self.data.ST_DIR[-2]
            if prev != 1 and curr == 1:
                if self.position: self.position.close()
                self.buy()
            elif prev != -1 and curr == -1:
                if self.position: self.position.close()
                self.sell()

        # 6. Triple SuperTrend + RSI
        elif sn == 'triple_st_rsi':
            st, rsi = self.data.ST_DIR[-1], self.data.RSI[-1]
            if st == 1 and rsi < 40:
                if not self.position.is_long:
                    if self.position: self.position.close()
                    self.buy()
            elif st == -1 and rsi > 60:
                if not self.position.is_short:
                    if self.position: self.position.close()
                    self.sell()

        # 7. VWAP Momentum
        elif sn == 'vwap_momentum':
            vwap = self.data.VWAP[-1]
            if close_px > vwap and close_px > self.data.Open[-1]:
                if not self.position.is_long:
                    if self.position: self.position.close()
                    self.buy()
            elif close_px < vwap and close_px < self.data.Open[-1]:
                if not self.position.is_short:
                    if self.position: self.position.close()
                    self.sell()

        # 8. MACD Trend Rider
        elif sn == 'macd_trend':
            m, sig, hist = self.data.MACD[-1], self.data.MACD_SIG[-1], self.data.MACD_HIST[-1]
            pm, psig = self.data.MACD[-2], self.data.MACD_SIG[-2]
            ema50 = self.data.EMA50[-1]
            if pm <= psig and m > sig and close_px > ema50:
                if self.position: self.position.close()
                self.buy()
            elif pm >= psig and m < sig and close_px < ema50:
                if self.position: self.position.close()
                self.sell()

        # 9. Bollinger Mean Reversion (Always In)
        elif sn == 'bollinger_mr':
            up, low_b, rsi = self.data.BB_UP[-1], self.data.BB_LOW[-1], self.data.RSI[-1]
            if close_px < low_b and rsi < 30:
                if not self.position.is_long:
                    if self.position: self.position.close()
                    self.buy()
            elif close_px > up and rsi > 70:
                if not self.position.is_short:
                    if self.position: self.position.close()
                    self.sell()

        # 10. Stochastic VWAP
        elif sn == 'stoch_vwap':
            stoch, vwap = self.data.STOCH_RSI[-1], self.data.VWAP[-1]
            if stoch < 20 and close_px > vwap:
                if not self.position.is_long:
                    if self.position: self.position.close()
                    self.buy()
            elif stoch > 80 and close_px < vwap:
                if not self.position.is_short:
                    if self.position: self.position.close()
                    self.sell()

        # 11. Heikin Ashi Sniper
        elif sn == 'heikin_ashi':
            hao, hac = self.data.HA_OPEN[-1], self.data.HA_CLOSE[-1]
            phao, phac = self.data.HA_OPEN[-2], self.data.HA_CLOSE[-2]
            if phac <= phao and hac > hao:
                if self.position: self.position.close()
                self.buy()
            elif phac >= phao and hac < hao:
                if self.position: self.position.close()
                self.sell()

        # 12. SuperTrend + SAR + ADX
        elif sn == 'st_sar_adx':
            st, psar = self.data.ST_DIR[-1], self.data.PSAR_DIR[-1]
            if st == 1 and psar == 1:
                if not self.position.is_long:
                    if self.position: self.position.close()
                    self.buy()
            elif st == -1 and psar == -1:
                if not self.position.is_short:
                    if self.position: self.position.close()
                    self.sell()

        # 13. Combo Bot (Always In / Atomic Flip)
        elif sn == 'combo_bot':
            # Uses EMA crossover + RSI filter for simplified backtest parity
            f, s, rsi = self.data.EMA9[-1], self.data.EMA21[-1], self.data.RSI[-1]
            if f > s and rsi > 50:
                if not self.position.is_long:
                    if self.position: self.position.close()
                    self.buy()
            elif f < s and rsi < 50:
                if not self.position.is_short:
                    if self.position: self.position.close()
                    self.sell()

        # 14. RSI + EMA + Pivot Points (Enhanced: Always In / Flip)
        elif sn == 'rsi_ema_pivot':
            rsi, f, s = self.data.RSI[-1], self.data.EMA20[-1], self.data.EMA50[-1]
            p = (self.data.High[-1] + self.data.Low[-1] + self.data.Close[-1]) / 3
            
            # --- ALWAYS IN BIAS ---
            signal = 0
            rsi_up = rsi >= 50
            price_up = close_px >= p

            if f > s: # Trend Bullish
                if rsi_up or price_up: signal = 1
                else: signal = 1 # Fallback to trend
            elif f < s: # Trend Bearish
                if not rsi_up or not price_up: signal = -1
                else: signal = -1 # Fallback to trend
                
            # FLIP LOGIC
            if signal == 1:
                if self.position.is_short: 
                    self.position.close()
                    self.buy()
                elif not self.position:
                    self.buy()
            elif signal == -1:
                if self.position.is_long:
                    self.position.close()
                    self.sell()
                elif not self.position:
                    self.sell()

        # Fallback (SMA Cross)
        else:
            ema20 = self.data.EMA20[-1] if 'EMA20' in self.data.df.columns else close_px
            if close_px > ema20:
                if not self.position.is_long:
                    if self.position: self.position.close()
                    self.buy()
            elif close_px < ema20:
                if not self.position.is_short:
                    if self.position: self.position.close()
                    self.sell()




# ============================================================
# AUTHORITATIVE INDICATOR COMPUTATION (DETERMINISTIC)
# Used by both the backtest and screener engines.
# PSAR uses a stable 20-candle majority-vote initialization
# to prevent non-determinism when dataset shifts by 1 candle.
# ============================================================

def compute_psar_dir(df_in, iaf=0.02, step=0.02, max_af=0.2):
    """Compute Parabolic SAR direction array. Returns list of 1 (bullish) or -1 (bearish)."""
    high = df_in['High'].values
    low  = df_in['Low'].values
    close = df_in['Close'].values
    n_len = len(high)
    direction = [1] * n_len
    if n_len < 2:
        return direction

    # Stable initialization: 20-candle majority vote (not single-candle coin-flip)
    init_look = min(20, n_len)
    bull_count = sum(1 for k in range(1, init_look) if close[k] > close[k-1])
    bear_count = (init_look - 1) - bull_count
    is_up_trend = bull_count >= bear_count

    af = iaf
    ep = high[0] if is_up_trend else low[0]
    psar_val = low[0] if is_up_trend else high[0]
    direction[0] = 1 if is_up_trend else -1

    for i in range(1, n_len):
        prev_sar = psar_val
        psar_val = prev_sar + af * (ep - prev_sar)

        if is_up_trend:
            psar_val = min(psar_val, low[i-1], low[max(0,i-2)])
            if low[i] < psar_val:
                is_up_trend = False
                psar_val = ep
                ep = low[i]
                af = iaf
            else:
                if high[i] > ep:
                    ep = high[i]
                    af = min(af + step, max_af)
        else:
            psar_val = max(psar_val, high[i-1], high[max(0,i-2)])
            if high[i] > psar_val:
                is_up_trend = True
                psar_val = ep
                ep = high[i]
                af = iaf
            else:
                if low[i] < ep:
                    ep = low[i]
                    af = min(af + step, max_af)

        direction[i] = 1 if is_up_trend else -1

    return direction


def compute_st_dir(df_in, period=10, mult=3):
    """Compute SuperTrend direction array. Returns list of 1 or -1."""
    high  = df_in['High'].values
    low   = df_in['Low'].values
    close = df_in['Close'].values
    atr   = [0.0] * len(close)
    for i in range(1, len(close)):
        tr = max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
        atr[i] = (atr[i-1] * (period - 1) + tr) / period if i >= period else tr
    direction = [1] * len(close)
    for i in range(period, len(close)):
        hl2   = (high[i] + low[i]) / 2
        upper = hl2 + mult * atr[i]
        lower = hl2 - mult * atr[i]
        if close[i] > upper:
            direction[i] = 1
        elif close[i] < lower:
            direction[i] = -1
        else:
            direction[i] = direction[i-1]
    return direction


@app.route('/api/backtest', methods=['POST'])

def api_run_backtest():
    try:
        data = request.get_json()
        raw_candles = data.get('candles', [])
        strategy_name = data.get('strategy', 'pure_supertrend')
        leverage = int(data.get('leverage', 10))
        bt_size = float(data.get('size', 100))
        symbol = data.get('symbol', 'BTCUSDT').upper()
        enable_hedge = data.get('enable_hedge', False)
        
        if not raw_candles or len(raw_candles) < 50:
            return jsonify({"error": "Not enough historical data provided (min 50 candles)."}), 400

        # Construct Base DataFrame from incoming candles
        df_main = pd.DataFrame(raw_candles)
        if df_main['time'].iloc[0] > 1e11:
            df_main['time'] = pd.to_datetime(df_main['time'], unit='ms')
        else:
            df_main['time'] = pd.to_datetime(df_main['time'], unit='s')
        df_main.set_index('time', inplace=True)
        df_main.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low', 'close': 'Close', 'volume': 'Volume'}, inplace=True)

        # Infer interval for resampling reference
        if len(df_main) > 1:
            interval_secs = int((df_main.index[1] - df_main.index[0]).total_seconds())
        else:
            interval_secs = 60

        final_df = df_main.copy()

        if enable_hedge:
            hedge_tf = data.get('hedge_tf', '1m')
            print(f"🛡️ [BACKTEST] High-Res Hedge Mode Enabled for {symbol} (Main={interval_secs}s, Hedge={hedge_tf})")
            # 1. Fetch hedge TF data for the whole range
            start_ms = int(df_main.index[0].timestamp() * 1000)
            end_ms = int(df_main.index[-1].timestamp() * 1000)
            
            # Note: 1500 is max klines. 
            hedge_raw, status = futures_get('/fapi/v1/klines', params={
                'symbol': symbol, 'interval': hedge_tf, 
                'startTime': start_ms, 'endTime': end_ms, 'limit': 1500
            })
            
            if status == 200 and isinstance(hedge_raw, list) and len(hedge_raw) > 50:
                df_hedge = pd.DataFrame(hedge_raw, columns=[
                    'time', 'Open', 'High', 'Low', 'Close', 'Volume', 'ct', 'qa', 'nt', 'tb', 'tq', 'i'
                ])
                df_hedge['time'] = pd.to_datetime(df_hedge['time'], unit='ms')
                df_hedge.set_index('time', inplace=True)
                for c in ['Open', 'High', 'Low', 'Close', 'Volume']: df_hedge[c] = df_hedge[c].astype(float)
                
                # Compute MAIN signals on the high-res timeline (sticky from main TF)
                # We resample df_hedge to Main TF, compute indicators, then ffill back
                res_rule = f"{interval_secs}s"
                df_res = df_hedge.resample(res_rule).agg({'Open': 'first', 'High': 'max', 'Low': 'min', 'Close': 'last', 'Volume': 'sum'})
                df_res.dropna(inplace=True)
                
                # Compute signals on resampled data
                if strategy_name == 'pure_parabolic_sar':
                    df_res['MAIN_SIG'] = compute_psar_dir(df_res)
                elif strategy_name in ('pure_supertrend', 'supertrend_scalp', 'pure_supertrend'):
                    df_res['MAIN_SIG'] = compute_st_dir(df_res)
                else:
                    # Fallback
                    df_res['MAIN_SIG'] = (df_res['Close'] > df_res['Close'].shift(1)).astype(int).replace(0, -1)
                
                # Re-join main signal into high-res timeline
                df_hedge = df_hedge.join(df_res[['MAIN_SIG']])
                df_hedge['MAIN_SIG'] = df_hedge['MAIN_SIG'].ffill().fillna(0)
                
                # Compute HEDGE signals on high-res
                df_hedge['HEDGE_SIG'] = compute_psar_dir(df_hedge)
                
                final_df = df_hedge
            else:
                print(f"⚠️ [BACKTEST] Failed to fetch {hedge_tf} hedge data for {symbol}. Falling back.")

        # ─── Authoritative Indicator Computation ───
        closes = final_df['Close'].values.tolist()
        closes_s = pd.Series(closes)
        
        # 1. PSAR/ST
        final_df['PSAR_DIR'] = compute_psar_dir(final_df)
        final_df['ST_DIR']   = compute_st_dir(final_df)
        
        # 2. RSI (Standard 14)
        def _rsi(s, period=14):
            delta = s.diff()
            gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
            loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
            rs = gain / loss
            return 100 - (100 / (1 + rs))
        
        final_df['RSI'] = _rsi(closes_s, 14).fillna(50)

        # 3. Bollinger Bands
        def _bb(s, period=20, std=2):
            sma = s.rolling(window=period).mean()
            sd = s.rolling(window=period).std()
            return sma + (std * sd), sma, sma - (std * sd)
            
        final_df['BB_UP'], final_df['BB_MID'], final_df['BB_LOW'] = _bb(closes_s)
        final_df['BB_UP'] = final_df['BB_UP'].bfill()
        final_df['BB_MID'] = final_df['BB_MID'].bfill()
        final_df['BB_LOW'] = final_df['BB_LOW'].bfill()

        # 4. EMAs
        def _ema_pd(s, period): return s.ewm(span=period, adjust=False).mean()
        final_df['EMA9'] = _ema_pd(closes_s, 9)
        final_df['EMA21'] = _ema_pd(closes_s, 21)
        final_df['EMA20'] = _ema_pd(closes_s, 20)
        final_df['EMA50'] = _ema_pd(closes_s, 50)
        
        # MACD (Standard 12,26,9)
        ema12 = _ema_pd(closes_s, 12)
        ema26 = _ema_pd(closes_s, 26)
        final_df['MACD'] = ema12 - ema26
        final_df['MACD_SIG'] = final_df['MACD'].ewm(span=9, adjust=False).mean()
        final_df['MACD_HIST'] = final_df['MACD'] - final_df['MACD_SIG']

        # HEIKIN ASHI
        ha_close = (final_df['Open'] + final_df['High'] + final_df['Low'] + final_df['Close']) / 4
        ha_open = final_df['Open'].copy()
        for i in range(1, len(final_df)):
            ha_open.iloc[i] = (ha_open.iloc[i-1] + ha_close.iloc[i-1]) / 2
        final_df['HA_OPEN'] = ha_open
        final_df['HA_CLOSE'] = ha_close

        
        # Inject config into the Strategy dynamically
        DynamicStrategy.strategy_name = strategy_name
        DynamicStrategy.enable_hedge = enable_hedge

        # Scale factor trick to bypass fractional assets
        scale_factor = 1000000.0
        virtual_cash = bt_size * scale_factor
        margin_req = 1.0 / leverage if leverage >= 1 else 1.0

        from backtesting import Backtest
        bt = Backtest(final_df, DynamicStrategy, cash=virtual_cash, commission=0.0004, margin=margin_req, trade_on_close=False)
        stats = bt.run()
        
        trades = stats['_trades']
        trade_log = []
        if not trades.empty:
            # Extract hedge event timestamps from the strategy instance
            bt_strategy = stats['_strategy']
            hedge_starts = getattr(bt_strategy, '_hedge_starts', [])
            hedge_ends = getattr(bt_strategy, '_hedge_ends', [])
            
            print(f"[BT] Logic generated {len(hedge_starts)} hedge starts and {len(hedge_ends)} hedge ends")
            
            for idx, row in trades.iterrows():
                side_str = "Long" if row['Size'] > 0 else "Short"
                tag = str(row.get('Tag', '')) 
                
                entry_time = row['EntryTime']
                exit_time = row['ExitTime']
                
                # Robust timestamp matching (handle potential nanosecond, offset, or TZ differences)
                et_naive = exit_time.tz_localize(None) if exit_time.tzinfo else exit_time
                en_naive = entry_time.tz_localize(None) if entry_time.tzinfo else entry_time
                
                is_hedge_start = any(abs((et_naive - h.tz_localize(None)).total_seconds()) < 1.0 for h in hedge_starts)
                is_hedge_end = any(abs((en_naive - h.tz_localize(None)).total_seconds()) < 1.0 for h in hedge_ends)
                
                hedge_status = None
                reason = "Indicator Signal"
                
                if is_hedge_start:
                    reason = "Hedge Start"
                    hedge_status = "Hedge Start"
                elif is_hedge_end:
                    reason = "Hedge End"
                    hedge_status = "Promoted to Main"

                trade_log.append({
                    "entry_time": entry_time.isoformat() + 'Z',
                    "exit_time": exit_time.isoformat() + 'Z',
                    "side": side_str,
                    "entry": float(row['EntryPrice']),
                    "exit": float(row['ExitPrice']),
                    "lev": leverage,
                    "pnl": float(row['PnL']) / scale_factor, 
                    "reason": reason,
                    "is_hedge": is_hedge_start,
                    "hedge_status": hedge_status
                })

        return jsonify({
            "success": True,
            "metrics": {
                "total_return_pct": float(stats['Return [%]']),
                "win_rate": float(stats['Win Rate [%]']) if not pd.isna(stats['Win Rate [%]']) else 0.0,
                "total_trades": len(trade_log),
                "max_drawdown_pct": float(stats['Max. Drawdown [%]']),
                "net_profit": sum(t['pnl'] for t in trade_log)
            },
            "trades": trade_log
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ============================================================
# SCREENER BACKTEST ENGINE — Multi-ticker, Multi-timeframe
# Runs DynamicStrategy on top tickers autonomously in-server
# ============================================================

def _fetch_klines_for_symbol(symbol, interval='1h', limit=300):
    """Fetch klines from Binance Futures and return a prepped DataFrame with indicator columns."""
    try:
        raw, status = futures_get('/fapi/v1/klines', params={
            'symbol': symbol.upper(),
            'interval': interval,
            'limit': limit
        })
        if status != 200 or not isinstance(raw, list) or len(raw) < 50:
            return None

        df = pd.DataFrame(raw, columns=[
            'open_time', 'open', 'high', 'low', 'close', 'volume',
            'close_time', 'quote_asset_volume', 'num_trades',
            'taker_buy_base', 'taker_buy_quote', 'ignore'
        ])
        df['open_time'] = pd.to_datetime(df['open_time'], unit='ms')
        df.set_index('open_time', inplace=True)
        for col in ['open', 'high', 'low', 'close', 'volume']:
            df[col] = df[col].astype(float)
        df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low', 'close': 'Close', 'volume': 'Volume'}, inplace=True)

        # --- Native Python indicator computation (no pandas_ta) ---
        closes = df['Close'].values.tolist()
        n = len(closes)

        # EMA
        def _ema(prices, period):
            k = 2 / (period + 1)
            vals = [None] * period
            vals[period - 1] = sum(prices[:period]) / period
            for i in range(period, len(prices)):
                vals.append(vals[-1] * (1 - k) + prices[i] * k)
            return vals

        ema20 = _ema(closes, 20)
        ema50 = _ema(closes, 50)

        # RSI (Wilder)
        def _rsi(prices, period=14):
            gains, losses = [], []
            for i in range(1, len(prices)):
                d = prices[i] - prices[i-1]
                gains.append(max(d, 0))
                losses.append(max(-d, 0))
            rsi = [None] * (period)
            avg_g = sum(gains[:period]) / period
            avg_l = sum(losses[:period]) / period
            rs = avg_g / avg_l if avg_l != 0 else 100
            rsi.append(100 - 100 / (1 + rs))
            for i in range(period, len(gains)):
                avg_g = (avg_g * (period - 1) + gains[i]) / period
                avg_l = (avg_l * (period - 1) + losses[i]) / period
                rs = avg_g / avg_l if avg_l != 0 else 100
                rsi.append(100 - 100 / (1 + rs))
            return rsi

        rsi_vals = _rsi(closes, 14)

        # SuperTrend (period=10, mult=3)
        def _supertrend(df_in, period=10, mult=3):
            high = df_in['High'].values
            low = df_in['Low'].values
            close = df_in['Close'].values
            atr = [0] * len(close)
            for i in range(1, len(close)):
                tr = max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
                atr[i] = (atr[i-1] * (period - 1) + tr) / period if i >= period else tr
            direction = [1] * len(close)
            for i in range(period, len(close)):
                hl2 = (high[i] + low[i]) / 2
                upper = hl2 + mult * atr[i]
                lower = hl2 - mult * atr[i]
                if close[i] > upper:
                    direction[i] = 1
                elif close[i] < lower:
                    direction[i] = -1
                else:
                    direction[i] = direction[i-1]
            return direction

        st_dir = _supertrend(df)

        # PSAR
        def _psar(df_in, iaf=0.02, step=0.02, max_af=0.2):
            high = df_in['High'].values
            low = df_in['Low'].values
            close = df_in['Close'].values
            n_len = len(high)
            
            direction = [1] * n_len
            if n_len < 2: return direction
            
            is_up_trend = (close[1] > close[0])
            af = iaf
            ep = high[0] if is_up_trend else low[0]
            psar_val = low[0] if is_up_trend else high[0]
            
            direction[0] = 1 if is_up_trend else -1
            
            for i in range(1, n_len):
                prev_sar = psar_val
                psar_val = prev_sar + af * (ep - prev_sar)
                
                if is_up_trend:
                    if i >= 2:
                        psar_val = min(psar_val, low[i-1], low[i-2])
                    else:
                        psar_val = min(psar_val, low[i-1])
                        
                    if low[i] < psar_val:
                        is_up_trend = False
                        psar_val = ep
                        ep = low[i]
                        af = iaf
                    else:
                        if high[i] > ep:
                            ep = high[i]
                            af = min(af + step, max_af)
                else:
                    if i >= 2:
                        psar_val = max(psar_val, high[i-1], high[i-2])
                    else:
                        psar_val = max(psar_val, high[i-1])
                        
                    if high[i] > psar_val:
                        is_up_trend = True
                        psar_val = ep
                        ep = high[i]
                        af = iaf
                    else:
                        if low[i] < ep:
                            ep = low[i]
                            af = min(af + step, max_af)
                
                direction[i] = 1 if is_up_trend else -1
                
            return direction

        psar_dir = _psar(df)

        # Rolling pivot (lookback = number of candles based on interval)
        lookback_map = {'1h': 24, '4h': 6, '15m': 96, '1m': 1440}
        lookback = lookback_map.get(interval, 24)
        highs = df['High'].values.tolist()
        lows = df['Low'].values.tolist()

        pivot_p, pivot_r1, pivot_s1, pivot_r2, pivot_s2 = [], [], [], [], []
        for i in range(n):
            si = max(0, i - lookback)
            rH = max(highs[si:i+1]) if i >= si else highs[i]
            rL = min(lows[si:i+1]) if i >= si else lows[i]
            P = (rH + rL + closes[i]) / 3
            pivot_p.append(P)
            pivot_r1.append((2*P) - rL)
            pivot_s1.append((2*P) - rH)
            pivot_r2.append(P + (rH - rL))
            pivot_s2.append(P - (rH - rL))

        df['EMA20'] = ema20
        df['EMA50'] = ema50
        df['RSI'] = rsi_vals
        df['ST_DIR'] = st_dir
        df['PSAR_DIR'] = psar_dir
        df['PIVOT_P'] = pivot_p
        df['PIVOT_R1'] = pivot_r1
        df['PIVOT_S1'] = pivot_s1
        df['PIVOT_R2'] = pivot_r2
        df['PIVOT_S2'] = pivot_s2

        df.bfill(inplace=True)
        df.ffill(inplace=True)
        df.dropna(inplace=True)
        return df if not df.empty else None

    except Exception as ex:
        print(f'[screener-bt] Error fetching {symbol}: {ex}')
        return None


def _compute_indicators(df):
    """
    Compute all indicator columns that DynamicStrategy.next() reads.
    Standardized to match the JS implementation for backtest parity.
    """
    import numpy as np

    close = df['Close'].values.astype(float)
    high  = df['High'].values.astype(float)
    low   = df['Low'].values.astype(float)
    n = len(close)

    # ── Helper: EMA ────────────────────────────────────────────────────────
    def ema(arr, period):
        alpha = 2.0 / (period + 1)
        res = np.full(len(arr), np.nan)
        if len(arr) < period: return res
        res[period - 1] = np.mean(arr[:period])
        for i in range(period, len(arr)):
            res[i] = (arr[i] - res[i-1]) * alpha + res[i-1]
        return res

    df['EMA9']   = ema(close, 9)
    df['EMA20']  = ema(close, 20)
    df['EMA21']  = ema(close, 21)
    df['EMA50']  = ema(close, 50)
    df['EMA200'] = ema(close, 200)

    # ── Helper: ATR ────────────────────────────────────────────────────────
    def compute_atr(h, l, c, p=14):
        tr = np.maximum(h - l, np.maximum(np.abs(h - np.roll(c, 1)), np.abs(l - np.roll(c, 1))))
        tr[0] = h[0] - l[0]
        atr_v = np.full(n, np.nan)
        atr_v[p - 1] = np.mean(tr[:p])
        for i in range(p, n):
            atr_v[i] = (atr_v[i-1] * (p - 1) + tr[i]) / p
        return atr_v
    df['ATR'] = compute_atr(high, low, close, 14)

    # ── RSI (Wilder Smoothing) ─────────────────────────────────────────────
    def compute_rsi(prices, period=14):
        rsi_arr = np.full(n, np.nan)
        if n <= period: return rsi_arr
        deltas = np.diff(prices)
        gains = np.where(deltas > 0, deltas, 0.0)
        losses = np.where(deltas < 0, -deltas, 0.0)
        avg_gain = np.mean(gains[:period])
        avg_loss = np.mean(losses[:period])
        for i in range(period, n - 1):
            avg_gain = (avg_gain * (period - 1) + gains[i]) / period
            avg_loss = (avg_loss * (period - 1) + losses[i]) / period
            rs = avg_gain / avg_loss if avg_loss != 0 else 0
            rsi_arr[i + 1] = 100 - (100 / (1 + rs))
        return rsi_arr
    df['RSI'] = compute_rsi(close, 14)

    # ── SuperTrend ─────────────────────────────────────────────────────────
    def compute_st(h, l, c, p=10, m=3):
        atr_v = compute_atr(h, l, c, p)
        upper = (h + l) / 2 + m * atr_v
        lower = (h + l) / 2 - m * atr_v
        f_upper = np.copy(upper)
        f_lower = np.copy(lower)
        st_dir = np.zeros(n)
        for i in range(1, n):
            if np.isnan(atr_v[i]): continue
            f_upper[i] = upper[i] if upper[i] < f_upper[i-1] or c[i-1] > f_upper[i-1] else f_upper[i-1]
            f_lower[i] = lower[i] if lower[i] > f_lower[i-1] or c[i-1] < f_lower[i-1] else f_lower[i-1]
            if st_dir[i-1] == 1:
                st_dir[i] = 1 if c[i] > f_lower[i] else -1
            elif st_dir[i-1] == -1:
                st_dir[i] = -1 if c[i] < f_upper[i] else 1
            else:
                st_dir[i] = 1 if c[i] > f_upper[i] else -1
        return st_dir
    df['ST_DIR'] = compute_st(high, low, close, 10, 3)

    # ── Parabolic SAR ──────────────────────────────────────────────────────
    df['PSAR_DIR'] = compute_psar_dir(df) 

    # ── MACD ───────────────────────────────────────────────────────────────
    def compute_macd(arr, fast=12, slow=26, sign=9):
        f = ema(arr, fast)
        s = ema(arr, slow)
        m = f - s
        sig = ema(m, sign)
        return m, sig, (m - sig)
    df['MACD'], df['MACD_SIG'], df['MACD_HIST'] = compute_macd(close)

    # ── Bollinger Bands ────────────────────────────────────────────────────
    def compute_bb(arr, p=20, m=2):
        mid = np.full(n, np.nan)
        std = np.full(n, np.nan)
        for i in range(p-1, n):
            window = arr[i-p+1:i+1]
            mid[i] = np.mean(window)
            std[i] = np.std(window)
        return mid + m*std, mid, mid - m*std
    df['BB_UP'], df['BB_MID'], df['BB_LOW'] = compute_bb(close)

    # ── Stochastic RSI ─────────────────────────────────────────────────────
    def compute_stoch(rsi_v, p=14):
        stoch = np.full(n, np.nan)
        for i in range(p-1, n):
            window = rsi_v[i-p+1:i+1]
            mi, ma = np.min(window), np.max(window)
            if ma - mi > 0: stoch[i] = (rsi_v[i] - mi) / (ma - mi)
            else: stoch[i] = 0.5
        return stoch * 100
    df['STOCH_RSI'] = compute_stoch(df['RSI'].values, 14)

    # ── Heikin Ashi ────────────────────────────────────────────────────────
    ha_close = (df['Open'] + df['High'] + df['Low'] + df['Close']) / 4
    ha_open = np.full(n, np.nan)
    ha_open[0] = (df['Open'].iloc[0] + df['Close'].iloc[0]) / 2
    for i in range(1, n):
        ha_open[i] = (ha_open[i-1] + ha_close.iloc[i-1]) / 2
    df['HA_OPEN'] = ha_open
    df['HA_CLOSE'] = ha_close

    # ── VWAP ───────────────────────────────────────────────────────────────
    df['VWAP'] = (df['Close'] * df['Volume']).cumsum() / df['Volume'].cumsum()

    # ── Daily Pivot Points ─────────────────────────────────────────────────
    prev_h, prev_l, prev_c = np.roll(high, 1), np.roll(low, 1), np.roll(close, 1)
    P = (prev_h + prev_l + prev_c) / 3
    df['PIVOT_P']  = P
    df['PIVOT_R1'] = 2 * P - prev_l
    df['PIVOT_S1'] = 2 * P - prev_h
    df['PIVOT_R2'] = P + (prev_h - prev_l)
    df['PIVOT_S2'] = P - (prev_h - prev_l)

    return df




def _run_strategy_on_df(df, strategy_name, leverage=10, bt_size=100):
    """
    Run DynamicStrategy on a given DataFrame and return metrics.
    Computes all indicator columns first so DynamicStrategy.next() gets proper signals.
    """
    try:
        from backtesting import Backtest

        # Compute all indicators — same columns that DynamicStrategy.next() reads
        df = _compute_indicators(df.copy())

        DynamicStrategy.strategy_name = strategy_name
        scale = 1_000_000.0
        virtual_cash = bt_size * scale
        margin_req = 1.0 / leverage if leverage >= 1 else 1.0
        bt = Backtest(df, DynamicStrategy, cash=virtual_cash, commission=0.0004, margin=margin_req, trade_on_close=False)
        stats = bt.run()
        trades = stats['_trades']
        trade_log = []
        if not trades.empty:
            for _, row in trades.iterrows():
                trade_log.append({
                    "side": "Long" if row['Size'] > 0 else "Short",
                    "entry": float(row['EntryPrice']),
                    "exit": float(row['ExitPrice']),
                    "pnl": float(row['PnL']) / scale,
                })
        net_pnl = sum(t['pnl'] for t in trade_log)
        win_rate = float(stats['Win Rate [%]']) if not pd.isna(stats['Win Rate [%]']) else 0.0
        n_trades = int(stats['# Trades'])
        max_dd = float(stats['Max. Drawdown [%]'])
        return {
            "net_pnl": net_pnl,
            "win_rate": win_rate,
            "trades": n_trades,
            "max_dd": max_dd,
            "trade_log": trade_log[-5:]   # last 5 trades
        }
    except Exception as ex:
        import traceback; traceback.print_exc()
        return None



@app.route('/api/screener-backtest', methods=['POST'])
def api_screener_backtest():
    """
    Parallel streaming SSE screener supporting specific or 'all' combinations.
    Jobs = (symbol, interval). Yields array of results across requested strategies per job.
    """
    import json as _json
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from flask import Response, stream_with_context

    ALL_STRATEGIES = [
        'pure_supertrend', 'supertrend_scalp', 'pure_parabolic_sar',
        'triple_st_rsi', 'rsi_reversal', 'rsi_ema_pivot',
        'vwap_momentum', 'macd_trend', 'bollinger_mr',
        'stoch_vwap', 'heikin_ashi', 'pure_rsi',
        'pure_ema', 'pure_rsi_ema', 'st_sar_adx'
    ]
    ALL_INTERVALS = ['1m', '3m', '5m', '15m', '1h', '4h', '1d']

    data = request.get_json()
    symbols = data.get('symbols', [])
    req_strat = data.get('strategy', 'all')
    req_iv = data.get('interval', 'all')
    leverage = int(data.get('leverage', 10))
    bt_size  = float(data.get('size', 100))

    if not symbols:
        return jsonify({"error": "No symbols provided"}), 400

    job_strats = ALL_STRATEGIES if req_strat == 'all' else [req_strat]
    job_ivs = ALL_INTERVALS if req_iv == 'all' else [req_iv]

    # Build full job list: (symbol, interval)
    jobs = [(sym, iv) for sym in symbols for iv in job_ivs]

    def _scan_job(sym, interval):
        """Fetch klines once, run requested strategies."""
        try:
            df = _fetch_klines_for_symbol(sym, interval=interval, limit=300) # Match frontend UI exactly for PSAR/EMA sync
            if df is None:
                return None
            
            results = []
            for strat in job_strats:
                metrics = _run_strategy_on_df(df, strat, leverage, bt_size)
                if metrics is None or metrics['trades'] == 0:
                    continue
                results.append({
                    'interval': interval,
                    'strategy': strat,
                    'net_pnl': metrics['net_pnl'],
                    'win_rate': metrics['win_rate'],
                    'trades': metrics['trades'],
                    'max_dd': metrics['max_dd']
                })
            return results
        except Exception:
            return None

    def _generate():
        total = len(jobs)
        done  = 0
        yield f"data: {_json.dumps({'type': 'start', 'total': total})}\n\n"

        with ThreadPoolExecutor(max_workers=16) as pool:
            futures = {pool.submit(_scan_job, sym, iv): (sym, iv) for sym, iv in jobs}
            for future in as_completed(futures):
                sym, iv = futures[future]
                done += 1
                res_arr = future.result()

                yield f"data: {_json.dumps({'type':'progress','done':done,'total':total,'symbol':sym,'interval':iv,'pct':round(done/total*100)})}\n\n"

                if res_arr and len(res_arr) > 0:
                    yield f"data: {_json.dumps({'type':'result','symbol':sym,'interval':iv,'results':res_arr})}\n\n"

        yield f"data: {_json.dumps({'type':'done'})}\n\n"

    return Response(
        stream_with_context(_generate()),
        content_type='text/event-stream',
        headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no','Access-Control-Allow-Origin':'*'}
    )


# ============================================================
# WebSocket Proxy — for frontend to connect to Binance WS
# ============================================================
@app.route('/api/ws-url/<symbol>')
def api_ws_url(symbol):
    """Returns the WebSocket URL for a symbol's trade stream."""
    sym = symbol.lower()
    return jsonify({
        "trade": f"wss://stream.binance.com:9443/ws/{sym}@trade",
        "kline_1m": f"wss://stream.binance.com:9443/ws/{sym}@kline_1m",
        "depth": f"wss://stream.binance.com:9443/ws/{sym}@depth20@100ms",
        "miniTicker": f"wss://stream.binance.com:9443/ws/{sym}@miniTicker",
        "aggTrade": f"wss://stream.binance.com:9443/ws/{sym}@aggTrade",
    })


# ============================================================
# Main
# ============================================================
@app.route('/api/backtest/klines/<symbol>')
def get_backtest_klines(symbol):
    interval = request.args.get('interval', '1h')
    days = int(request.args.get('days', 1))
    
    # Calculate startTime based on days
    limit = 1000 # Max limit per call
    end_time = int(time.time() * 1000)
    start_time = end_time - (days * 24 * 60 * 60 * 1000)
    
    params = {
        "symbol": symbol.upper(),
        "interval": interval,
        "startTime": start_time,
        "endTime": end_time,
        "limit": limit
    }
    
    data, status = futures_get('/fapi/v1/klines', params=params)
    if status != 200:
        return jsonify(data), status

    # Format for lightweight-charts
    candles = []
    for k in data:
        candles.append({
            "time": k[0] / 1000,
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "volume": float(k[5])
        })
    return jsonify(candles)

# --- 404 Fallback for SPA Routing (Deep Linking) ---
@app.errorhandler(404)
def handle_404(e):
    # If the request is for an API, send a proper 404 JSON
    if request.path.startswith('/api/'):
        return jsonify({"error": "Endpoint not found"}), 404
    # Otherwise, serve index.html to allow frontend routing
    return send_from_directory('.', 'index.html')

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Binance Trading Bot Server')
    parser.add_argument('--port', '-p', type=int, default=8000, help='Port to run the server on (default: 8000)')
    parser.add_argument('port_positional', nargs='?', type=int, default=None, help='(legacy) Port as positional arg')
    args = parser.parse_args()
    port = args.port_positional if args.port_positional else args.port
    print(f"""
╔══════════════════════════════════════════╗
║     🟡 BINANCE TRADING BOT v1.0 🟡      ║
║                                          ║
║  Dashboard: http://localhost:{port}         ║
║  API Key:   {BINANCE_API_KEY[:12]}...          ║
║  Status:    {'🟢 READY' if BINANCE_SECRET_KEY != 'YOUR_SECRET_KEY_HERE' else '🔴 SET SECRET KEY'}               ║
╚══════════════════════════════════════════╝
    """)
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
