#!/bin/bash
# Pull a model onto the remote Ollama host (ollama pull, over HTTP).
#
# The download happens on THAT machine and lands on ITS disk: nothing is written
# here. Expect ~15-20 GB per Q4_K_M 27-32B model, so watch that box's free space.
#
#   ./scripts/ollama-pull.sh qwen3-vl:8b
#   ./scripts/ollama-pull.sh nomic-embed-text-v2-moe
#
# Progress is rendered from the NDJSON stream /api/pull returns; a pull that
# streams no bytes and then ends without "success" is reported as a failure
# rather than being mistaken for a finished download.
set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_HOST=192.168.2.10
DEFAULT_PORT=11434
CONFIG=config.yaml

PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

usage() {
  cat <<'USAGE'
Usage: ollama-pull.sh MODEL

  MODEL       model to download, e.g. qwen3-vl:8b or nomic-embed-text-v2-moe
  -h, --help  show this help

Pulling overwrites nothing that is already installed and shares blobs it can.
Host comes from config.yaml unless OLLAMA_HOST is set.
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


def get(path, timeout=30):
    with urllib.request.urlopen(f"{base}{path}", timeout=timeout) as resp:
        return json.loads(resp.read())


print(f"⬇️   pulling {norm(model)} onto {base}")
print("    (downloaded on the remote machine, not here)")

payload = json.dumps({"model": model, "stream": True}).encode()
req = urllib.request.Request(
    f"{base}/api/pull", data=payload, headers={"Content-Type": "application/json"}
)
try:
    resp = urllib.request.urlopen(req, timeout=60)
except urllib.error.HTTPError as exc:
    body = exc.read().decode(errors="replace").strip()
    fail(f"pull rejected (HTTP {exc.code}): {body or 'no detail'}")
except Exception as exc:
    fail(f"cannot reach {base} — {exc}")

tty = sys.stdout.isatty()
sizes = {}  # digest -> (completed, total), summed for one overall bar
last_pct = -1.0
succeeded = False
last_status = ""

for raw in resp:
    line = raw.decode(errors="replace").strip()
    if not line:
        continue
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue
    if event.get("error"):
        fail(event["error"])
    status = event.get("status", "")
    last_status = status
    # Every layer reports its own counters; summing them gives the real total.
    if event.get("digest") and event.get("total"):
        sizes[event["digest"]] = (event.get("completed", 0), event["total"])
    if status == "success":
        succeeded = True
        continue

    total = sum(t for _, t in sizes.values())
    done = sum(c for c, _ in sizes.values())
    if not total:
        # Manifest pull, verification, "writing manifest" — no byte counts yet.
        if tty:
            sys.stdout.write(f"\r    {status[:70]:<70}")
            sys.stdout.flush()
        else:
            print(f"    {status}")
        continue

    pct = 100 * done / total
    if tty:
        sys.stdout.write(
            f"\r    {pct:5.1f}%  {done / 1e9:5.1f}/{total / 1e9:5.1f} GB  "
            f"{status.split()[0][:18]:<18}"
        )
        sys.stdout.flush()
    elif pct - last_pct >= 5:
        last_pct = pct
        print(f"    {pct:5.1f}%  {done / 1e9:5.1f}/{total / 1e9:5.1f} GB")
if tty:
    print()

if not succeeded:
    fail(f"stream ended without success (last status: {last_status or 'none'})")

# "success" is the daemon's word for it; check the model really is in the list.
try:
    installed = {m["name"] for m in get("/api/tags").get("models") or []}
except Exception as exc:
    fail(f"pulled, but could not confirm via /api/tags — {exc}")
target = norm(model)
if target not in installed:
    fail(f"pull reported success but {target} is not in /api/tags")

print(f"✅  {target} is installed")
PY
