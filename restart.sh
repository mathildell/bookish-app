#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "🛑  Stopping servers..."
pkill -f "uvicorn backend.main" || true
pkill -f "next dev"       || true
sleep 1

echo "🧹  Clearing caches..."
find backend lib -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
rm -rf frontend/.next/cache 2>/dev/null || true

echo "🚀 Starting uvicorn:8000..."
nohup .venv/bin/python -m uvicorn backend.main:app \
  --host 0.0.0.0 --port 8000 --reload > /tmp/uvicorn.log 2>&1 &

echo "🚀 Starting Next.js:3000..."
pushd frontend > /dev/null
nohup npm run dev > /tmp/nextjs.log 2>&1 &
popd > /dev/null

sleep 2
ps aux | grep -E "uvicorn|next dev" | grep -v grep
echo ""
echo "✅ Done — backend:8000  frontend:3000"
