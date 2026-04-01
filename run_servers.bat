@echo off
echo Starting Main Binance Server...
start "Binance Terminal Main (8000)" python server.py 8000

echo Starting Backtest Environment 1...
start "Binance Terminal (8001)" python server.py 8001

echo Starting Backtest Environment 2...
start "Binance Terminal (8002)" python server.py 8002

echo Starting Backtest Environment 3...
start "Binance Terminal (8003)" python server.py 8003

echo ---------------------------------------------------
echo All 4 environments are now running!
echo main app: http://localhost:8000
echo backtest 1: http://localhost:8001
echo backtest 2: http://localhost:8002
echo backtest 3: http://localhost:8003
echo ---------------------------------------------------
pause
