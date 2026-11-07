#!/bin/bash
# Delete models from the remote Ollama host (ollama rm, over HTTP).
#
# Irreversible: the weights are gone and a later use means pulling 15-20 GB again.
# Deleting a model the app is configured to use breaks that feature until it is
# back — and for the embedding model that means re-embedding the whole library,
# so those are refused unless --force is given.
#
#   ./scripts/ollama-rm.sh devstral-small-2:latest
#   ./scripts/ollama-rm.sh a:1 b:2 -y             # several at once, no prompt
#   ./scripts/ollama-rm.sh qwen3-vl:8b --force    # even though config.yaml uses it
#
# Sizes shared between tags are not counted twice by Ollama, so the total printed
# here is an upper bound on the space freed.
set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_HOST=192.168.2.10
DEFAULT_PORT=11434
CONFIG=config.yaml

PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

usage() {
  cat <<'USAGE'
Usage: ollama-rm.sh [options] MODEL [MODEL...]

  MODEL        model to delete, e.g. devstral-small-2:latest
  -y, --yes    skip the confirmation prompt (for scripts)
  --force      allow deleting a model that config.yaml still points at
  -h, --help   show this help

Without -y the models and their sizes are listed and "yes" must be typed.
Host comes from config.yaml unless OLLAMA_HOST is set.
USAGE
}

YES=0
FORCE=0
MODELS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)   YES=1 ;;
    --force)    FORCE=1 ;;
    -h|--help)  usage; exit 0 ;;
    -*)         echo "Unknown option: $1"; echo; usage; exit 2 ;;
    *)          MODELS+=("$1") ;;
  esac
  shift
done

if [ ${#MODELS[@]} -eq 0 ]; then
  echo "At least one model name is required."
  echo
  usage
  exit 2
fi

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

"$PY" - "$BASE" "$CONFIG" "$YES" "$FORCE" "${MODELS[@]}" <<'PY'
import json
import re
import sys
import urllib.error
import urllib.request

base, config_path, yes, force = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4] == "1"
requested = sys.argv[5:]


def norm(name):
    return name if ":" in name.split("/")[-1] else f"{name}:latest"


def fail(msg, code=1):
    print(f"❌  {msg}", file=sys.stderr)
    sys.exit(code)


def get(path, timeout=20):
    with urllib.request.urlopen(f"{base}{path}", timeout=timeout) as resp:
        return json.loads(resp.read())


try:
    installed = {
        norm(m["name"]): (m["name"], m.get("size", 0))
        for m in (get("/api/tags").get("models") or [])
    }
except urllib.error.HTTPError as exc:
    fail(f"{base} answered HTTP {exc.code}")
except Exception as exc:
    fail(f"cannot reach {base} — {exc}")

# Which config.yaml setting points at each model, so an accidental delete of the
# chat/writing/embedding model is caught before anything is removed.
roles = {}
try:
    with open(config_path) as fh:
        text = fh.read()
except OSError:
    text = ""
for key, name in re.findall(r"^\s*(\w*model)\s*:\s*['\"]?([^\s'\"]+)", text, re.M):
    roles.setdefault(norm(name), []).append(key)

missing = [m for m in requested if norm(m) not in installed]
if missing:
    fail(
        "not installed: "
        + ", ".join(missing)
        + f"\n    Run ./scripts/ollama-list.sh to see what {base} has."
    )

targets = [(norm(m), *installed[norm(m)]) for m in requested]

blocked = [t for t in targets if roles.get(t[0]) and not force]
if blocked:
    print("❌  refusing to delete models config.yaml still uses:")
    for name, _, _ in blocked:
        print(f"      {name}  ->  {', '.join(roles[name])}")
    print()
    print("    Point those settings at another model first, or re-run with --force.")
    sys.exit(1)

total = sum(size for _, _, size in targets)
print(f"About to delete {len(targets)} model(s) from {base}:")
for name, _, size in targets:
    print(f"    {name:<50} {size / 1e9:6.1f} GB")
print(f"    {'':<50} {total / 1e9:6.1f} GB total")
print()

if not yes:
    print("This cannot be undone.")
    try:
        answer = input("Type 'yes' to delete: ")
    except EOFError:
        answer = ""
    if answer.strip().lower() != "yes":
        sys.exit("aborted — nothing was deleted")

failures = []
for name, _, _ in targets:
    payload = json.dumps({"model": name}).encode()
    req = urllib.request.Request(
        f"{base}/api/delete",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="DELETE",
    )
    try:
        with urllib.request.urlopen(req, timeout=60):
            pass
        print(f"🗑️   deleted {name}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace").strip()
        print(f"❌  {name}: HTTP {exc.code} {body}", file=sys.stderr)
        failures.append(name)
    except Exception as exc:
        print(f"❌  {name}: {exc}", file=sys.stderr)
        failures.append(name)

# Trust the list, not the response codes.
try:
    remaining = {m["name"] for m in get("/api/tags").get("models") or []}
except Exception as exc:
    fail(f"deleted, but could not re-check /api/tags — {exc}")

still_there = [name for name, _, _ in targets if name in remaining]
if still_there:
    fail("still installed after delete: " + ", ".join(still_there))
if failures:
    sys.exit(1)

print(f"✅  {len(targets)} model(s) removed, ~{total / 1e9:.1f} GB freed")
PY
