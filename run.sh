#!/usr/bin/env bash
# Start the recorder/dashboard and publish it through Tailscale Funnel.
#   ./run.sh                 start (Funnel on 443 -> localhost:$PORT)
#   NO_FUNNEL=1 ./run.sh     local/tailnet only
#   ./run.sh funnel-off      remove the public Funnel
#   ./run.sh test            run the end-to-end tests
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8765}"

if [ ! -x .venv/bin/python ]; then
  echo "creating .venv ..."
  if command -v uv >/dev/null; then uv venv -q .venv && uv pip install -q --python .venv/bin/python -r requirements.txt
  else python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; fi
fi

case "${1:-}" in
  funnel-off) tailscale funnel --https=443 off; exit ;;
  test) exec .venv/bin/python -m pytest -q tests ;;
esac

command -v ffmpeg >/dev/null || echo "warning: ffmpeg not found - no MP4 export or live video preview"

if [ "${NO_FUNNEL:-0}" != 1 ] && command -v tailscale >/dev/null; then
  if tailscale funnel --bg "$PORT" >/dev/null; then
    echo "Tailscale Funnel: https://$(tailscale status --self --json | .venv/bin/python -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')/ -> localhost:$PORT"
  else
    echo "could not start Funnel. Once: sudo tailscale set --operator=\$USER  (and enable Funnel for this node in the admin console)"
  fi
fi

exec .venv/bin/python server/server.py --port "$PORT" "$@"
