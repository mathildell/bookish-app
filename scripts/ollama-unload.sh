#!/bin/bash
# Unload a resident model from the remote Ollama host — no delete, no reboot.
#
# This is the drain for a saturated box: abandoned or timed-out generations leave
# their model pinned in memory (and a queue of half-finished work behind it), so
# the next request waits for the load it should never have needed. Setting
# keep_alive to 0 tells the daemon to let the model go now; the weights stay on
# disk and the next request simply reloads them.
#
#   ./scripts/ollama-unload.sh qwen3:30b-a3b-instruct-2507-q4_K_M
#
# Only models already resident are touched: /api/generate on a model that is not
# loaded would load it first, which is the opposite of what this is for.
set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_HOST=192.168.2.10
DEFAULT_PORT=11434
CONFIG=config.yaml

PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

usage() {
  cat <<'USAGE'
Usage: ollama-unload.sh MODEL

  MODEL       model currently resident on the host, e.g. qwen3-vl:8b
  -h, --help  show this help

Exits 0 and does nothing if the model is not loaded. Host comes from config.yaml
unless OLLAMA_HOST is set.
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "")        echo "A model name is required."; echo; usage; exit 2 ;;
  -*)        echo "Unknown option: $1"; echo; usage; exit 2 ;;
esac
MODEL="$1"

cfg_get() {
  awk -v key="$1" '
    /^ollama:/ { inblock = 1; next }
    inblock && /^[^[:space:]]/ { inblock = 0 }
    inblock && $1 == key { print $2; exit }
  ' "$CONFIG" 2>/dev/null
}

if [ -n "${OLLAMA_HOST:-}" ]; then
  BASE="${OLLAMA_HOST%/}"
else
  BASE="http://$(cfg_get host:):$(cfg_get port:)"
fi

"$PY" - "$BASE" "$MODEL" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base, model = sys.argv[1], sys.argv[2]


def norm(name):
    return name if ":" in name.split("/")[-1] else f"{name}:latest"


def fail(msg, code=1):
    print(f"❌  {msg}", file=sys.stderr)
    sys.exit(code)


def get(path, timeout=20):
    with urllib.request.urlopen(f"{base}{path}", timeout=timeout) as resp:
        return json.loads(resp.read())


def resident():
    return get("/api/ps").get("models") or []


try:
    loaded = resident()
except urllib.error.HTTPError as exc:
    fail(f"{base} answered HTTP {exc.code}")
except Exception as exc:
    fail(f"cannot reach {base} — {exc}")

match = [m for m in loaded if norm(m["name"]) == norm(model)]
if not match:
    others = ", ".join(sorted(m["name"] for m in loaded)) or "nothing"
    print(f"💤  {norm(model)} is not loaded — nothing to do (resident: {others})")
    sys.exit(0)

name = match[0]["name"]  # the exact spelling the daemon uses
vram = match[0].get("size_vram") or match[0].get("size") or 0
print(f"🧹  unloading {name}  ({vram / 1e9:.1f} GB resident)")

payload = json.dumps({"model": name, "keep_alive": 0}).encode()
req = urllib.request.Request(
    f"{base}/api/generate",
    data=payload,
    headers={"Content-Type": "application/json"},
)
try:
    # No prompt: this is purely a "let it go" call, and it answers in one event.
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read() or b"{}")
except urllib.error.HTTPError as exc:
    detail = exc.read().decode(errors="replace").strip()
    fail(f"unload rejected (HTTP {exc.code}): {detail or 'no detail'}")
except Exception as exc:
    fail(f"cannot reach {base} — {exc}")
if body.get("error"):
    fail(body["error"])

try:
    remaining = [m["name"] for m in resident() if norm(m["name"]) == norm(model)]
except Exception as exc:
    fail(f"unload sent, but could not confirm via /api/ps — {exc}")

if remaining:
    fail(f"{name} is still resident (another request may be holding it)")
print(f"✅  {name} released, ~{vram / 1e9:.1f} GB freed; weights stay on disk")
PY
