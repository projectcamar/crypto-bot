# Binance Trading Bot

A high-performance trading bot for Binance Futures and Spot markets, featuring a modern terminal-grade dashboard.

## Features
- **Real-Time Data**: WebSocket-based price streaming with REST fallback.
- **Advanced Charting**: Integrated Lightweight-Charts with technical indicators.
- **Multi-Strategy Support**: SuperTrend, RSI/EMA, Scalping, and more.
- **HFT Engine**: 50ms decision loop for high-frequency trading.
- **Trade Management**: Automated Profit Lock, Partial Take Profit, and Trailing Stop Loss.

## How to Run
1.  **Setup Environment**: Ensure you have Python 3.8+ installed.
2.  **Install Dependencies**:
    ```bash
    pip install flask flask-cors requests websockets pandas pandas_ta backtesting
    ```
3.  **Configure API Keys**: Update `server.py` with your Binance API Key and Secret.
4.  **Start the Server**:
    ```bash
    python server.py
    ```
5.  **Open Dashboard**: Access `http://localhost:8000` in your browser.

## Project Structure
- `server.py`: Flask backend and Binance API integration.
- `binance_engine.py`: Core trading logic and execution.
- `hft_engine.py`: Ultra-fast decision engine.
- `app.js` & `index.html`: Modern, responsive frontend dashboard.
- `strategies/`: Modular strategy definitions.
