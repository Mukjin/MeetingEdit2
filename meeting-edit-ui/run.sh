#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

echo "▶ Meeting Edit UI"
echo ""

# Install backend deps
cd "$BACKEND"
if ! python3 -c "import fastapi" 2>/dev/null; then
  echo "Installing backend deps..."
  pip3 install -r requirements.txt --break-system-packages -q
fi

# Install frontend deps
cd "$FRONTEND"
if [ ! -d node_modules ]; then
  echo "Installing frontend deps..."
  npm install --silent
fi

# Start backend
cd "$BACKEND"
echo "Starting backend on http://localhost:8000"
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

# Start frontend
cd "$FRONTEND"
echo "Starting frontend on http://localhost:5173"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:5173"
echo ""
echo "Ctrl+C to stop both."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
