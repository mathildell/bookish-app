#!/bin/bash
# List the models installed on the remote Ollama host (ollama list, over HTTP).
#
# The daemon on the box in config.yaml has no authentication, so its API is
# reachable from here exactly like the app's own calls — no shell access needed.
#
#   ./scripts/ollama-list.sh              every model, largest first
#   ./scripts/ollama-list.sh qwen         only names containing "qwen"
#
# Host and port come from config.yaml (ollama.host / ollama.port), so this always
# looks at the same machine the app talks to. OLLAMA_HOST overrides:
#   OLLAMA_HOST=http://127.0.0.1:11434 ./scripts/ollama-list.sh
set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_HOST=192.168.2.10
DEFAULT_PORT=11434
CONFIG=config.yaml

PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

usage() {
  cat <<'USAGE'
Usage: ollama-list.sh [FILTER]

  (no args)   list every model on the host, largest first
  FILTER      only show names containing FILTER
  -h, --help  show this help

The ROLES column shows which config.yaml setting uses the model (chat,
extraction, writing, embedding) and whether it is resident in memory (loaded).
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  -*)        echo "Unknown option: $1"; echo; usage; exit 2 ;;
esac
FILTER="${1:-}"

# Pull one key out of the ollama: block without a YAML parser, so this works
# whether or not the venv happens to be active.
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

"$PY" - "$BASE" "$FILTER" "$CONFIG" <<'PY'
import json
import re
import sys
import urllib.error
import urllib.request

base, flt, config_path = sys.argv[1], sys.argv[2], sys.argv[3]


def get(path, timeout=20):
    with urllib.request.urlopen(f"{base}{path}", timeout=timeout) as resp:
        return json.loads(resp.read())


# Tags in /api/tags are always fully qualified ("name:latest"), config.yaml is
# not ("nomic-embed-text-v2-moe"), so compare with the tag filled in.
def norm(name):
    return name if ":" in name.split("/")[-1] else f"{name}:latest"


try:
    tags = get("/api/tags")
except urllib.error.HTTPError as exc:
    sys.exit(f"❌  {base} answered HTTP {exc.code}")
except Exception as exc:
    sys.exit(f"❌  cannot reach {base} — {exc}")

models = tags.get("models") or []
if not models:
    sys.exit("No models installed.")

try:
    running = {norm(m["name"]) for m in get("/api/ps").get("models") or []}
except Exception:
    running = set()

# Which app setting points at each model, e.g. "chat", "writing".
roles = {}
try:
    with open(config_path) as fh:
        text = fh.read()
except OSError:
    text = ""
for key, name in re.findall(r"^\s*(\w*model)\s*:\s*['\"]?([^\s'\"]+)", text, re.M):
    roles.setdefault(norm(name), []).append(key.replace("_model", ""))

visible = models
if flt:
    visible = [m for m in models if flt.lower() in m["name"].lower()]
    if not visible:
        sys.exit(f"No model name contains {flt!r}.")

visible.sort(key=lambda m: m.get("size", 0), reverse=True)
width = max(len(m["name"]) for m in visible)

print(f"{'MODEL':<{width}}  {'SIZE':>9}  {'PARAMS':>7}  {'QUANT':<8}  ROLES")
for m in visible:
    details = m.get("details") or {}
    notes = list(roles.get(norm(m["name"]), []))
    if norm(m["name"]) in running:
        notes.append("loaded")
    print(
        f"{m['name']:<{width}}  "
        f"{m.get('size', 0) / 1e9:8.1f}G  "
        f"{details.get('parameter_size', '?'):>7}  "
        f"{details.get('quantization_level', '?'):<8}  "
        f"{', '.join(notes)}"
    )

total = sum(m.get("size", 0) for m in visible)
print()
print(
    f"{len(visible)} model{'s' if len(visible) != 1 else ''}, "
    f"{total / 1e9:.1f} GB"
    + (" (filtered)" if flt else " on disk")
)
if running:
    print(f"resident now: {', '.join(sorted(running))}")
PY
