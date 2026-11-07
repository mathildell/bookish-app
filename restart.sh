#!/bin/bash
# Restart the backend (:8000) and frontend (:3000) dev servers.
#
# Stops them the hard way: SIGTERM first, then SIGKILL for anything that ignores
# it. A wedged uvicorn worker keeps holding its listening socket and never reacts
# to a polite shutdown, which is what makes the next start fail with "address
# already in use". Anything still holding the ports is killed by PID before the
# new server is launched.
#
#   ./restart.sh                    stop, then start both servers
#   ./restart.sh --stop-only        stop both servers and exit
#   ./restart.sh --clear-cache      also wipe caches before starting
#   ./restart.sh --stop-only --clear-cache
set -uo pipefail

cd "$(dirname "$0")"
mkdir -p data

STOP_ONLY=0
CLEAR_CACHE=0

usage() {
  cat <<'USAGE'
Usage: restart.sh [--stop-only] [--clear-cache]

  (no flags)      restart the backend (:8000) and frontend (:3000)
  --stop-only     stop both servers and exit; nothing is started
  --clear-cache   also delete backend/lib __pycache__ and frontend/.next/cache
  -h, --help      show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --stop-only)    STOP_ONLY=1 ;;
    --clear-cache)  CLEAR_CACHE=1 ;;
    -h|--help)      usage; exit 0 ;;
    *)
      echo "Unknown option: $1"
      echo
      usage
      exit 2
      ;;
  esac
  shift
done

# ---------------------------------------------------------------- helpers ----

# This script and the shells that launched it must never be killed, even if a
# pattern happens to match their command lines.
SELF_IDS=""
_p=$$
while [ -n "$_p" ] && [ "$_p" -gt 1 ]; do
  SELF_IDS="$SELF_IDS $_p"
  _p=$(ps -o ppid= -p "$_p" 2>/dev/null | tr -d ' ')
done

is_self() {
  case " $SELF_IDS " in *" $1 "*) return 0 ;; esac
  return 1
}

matching_pids() {
  local pid
  for pid in $(pgrep -f "$1" 2>/dev/null); do
    is_self "$pid" || echo "$pid"
  done
}

port_pids() {
  ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

STOPPED=""

kill_pids() {
  local label="$1"
  shift
  local pids="$*"
  [ -z "${pids// /}" ] && return 0

  STOPPED=1
  echo "   TERM  $label ($pids)"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true

  local attempt pid alive
  for attempt in $(seq 1 10); do
    alive=""
    for pid in $pids; do
      kill -0 "$pid" 2>/dev/null && alive="$alive $pid"
    done
    [ -z "${alive// /}" ] && return 0
    sleep 0.3
  done

  echo "   KILL  $label ($alive) — still alive after SIGTERM"
  # shellcheck disable=SC2086
  kill -9 $alive 2>/dev/null || true
}

# ------------------------------------------------------------------ stop -----

echo "🛑  Stopping servers..."
kill_pids "uvicorn"    "$(matching_pids 'uvicorn backend.main')"
kill_pids "next dev"   "$(matching_pids 'next dev')"
# Orphaned workers can hold the socket even after their reloader is gone.
kill_pids "port :8000" "$(port_pids 8000)"
kill_pids "port :3000" "$(port_pids 3000)"
[ -z "$STOPPED" ] && echo "   nothing was running"
rm -f data/backend.pid

for _ in $(seq 1 20); do
  [ -z "$(port_pids 8000)" ] && [ -z "$(port_pids 3000)" ] && break
  sleep 0.5
done
if [ -n "$(port_pids 8000)" ]; then
  echo "❌  Port 8000 is still held by PID(s): $(port_pids 8000)"
  exit 1
fi

# ----------------------------------------------------------------- cache -----

if [ "$CLEAR_CACHE" = "1" ]; then
  echo "🧹  Clearing caches..."
  find backend lib -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
  rm -rf frontend/.next/cache 2>/dev/null || true
fi

if [ "$STOP_ONLY" = "1" ]; then
  echo "✅ Stopped — backend:8000 and frontend:3000 are down (nothing restarted)"
  exit 0
fi

# ----------------------------------------------------------------- start -----

echo "🚀  Starting uvicorn:8000..."
# setsid puts each server in its own session: closing this terminal — or whatever
# launched the script — must not take the servers down with it.
setsid nohup .venv/bin/python -m uvicorn backend.main:app \
  --host 0.0.0.0 --port 8000 --reload > /tmp/uvicorn.log 2>&1 < /dev/null &

healthy=""
for i in $(seq 1 60); do
  if curl -sf -m 2 http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo "   backend healthy after ${i}s"
    healthy=1
    break
  fi
  sleep 1
done
if [ -z "$healthy" ]; then
  echo "❌  backend never answered /api/health; last log lines:"
  tail -n 20 /tmp/uvicorn.log
  exit 1
fi
port_pids 8000 | head -1 > data/backend.pid
echo "   listening pid $(cat data/backend.pid)"

echo "🚀  Starting Next.js:3000..."
# --port 3000 is explicit: left to itself, Next quietly picks a random free port
# when 3000 looks busy, leaving the old instance serving :3000.
pushd frontend > /dev/null
setsid nohup npm run dev -- --port 3000 > /tmp/nextjs.log 2>&1 < /dev/null &
popd > /dev/null

frontend=""
for i in $(seq 1 60); do
  if [ -n "$(port_pids 3000)" ]; then
    echo "   frontend listening after ${i}s (pid $(port_pids 3000 | head -1))"
    frontend=1
    break
  fi
  sleep 1
done
if [ -z "$frontend" ]; then
  echo "❌  frontend never bound :3000; last log lines:"
  tail -n 20 /tmp/nextjs.log
  exit 1
fi

ps aux | grep -E "uvicorn|next dev" | grep -v grep
echo ""
echo "✅ Done — backend:8000  frontend:3000"
