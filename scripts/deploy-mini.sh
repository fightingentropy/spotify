#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts"
cd "$ROOT_DIR"

MINI_HOST="${MINI_HOST:-}"
MINI_HOSTS="${MINI_HOSTS:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/spotify}"
BUN_BIN="${BUN_BIN:-/opt/homebrew/bin/bun}"
SKIP_BUILD=0
SKIP_INSTALL=0

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-mini.sh [options]

Builds the frontend, syncs the local music server to the Mac mini, installs
production dependencies, and restarts the launchd server. Keeps the previous
frontend's hashed assets available so open tabs can finish loading their routes.

Options:
  --skip-build          Reuse existing dist/.
  --skip-install        Sync files but do not run bun install or restart launchd.
  -h, --help            Show this help.

Environment:
  MINI_HOST             Explicit Mac mini SSH host.
  MINI_HOSTS            Fallback hosts. Default: m4mini-ts, Tailscale IP, m4mini.local, LAN IP.
  SSH_KEY               Default: ~/.ssh/id_ed25519_codex_m4mini
  REMOTE_APP            Default: /Users/hermes/Developer/spotify
  BUN_BIN               Default: /opt/homebrew/bin/bun
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

source "$SCRIPT_DIR/mini-host.sh"
resolve_mini_host

SSH_BASE=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout="${MINI_CONNECT_TIMEOUT:-10}")
RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=${MINI_CONNECT_TIMEOUT:-10}"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  bun run build
fi

[[ -f dist/client/index.html ]] || { echo "Missing dist/client/index.html. Run without --skip-build first." >&2; exit 1; }

SPOTIFY_DEPLOY_TMP="$(mktemp -d /tmp/spotify-deploy-assets.XXXXXX)"
trap 'rm -rf "$SPOTIFY_DEPLOY_TMP"' EXIT
python3 - "$SPOTIFY_DEPLOY_TMP/client-assets.next.json" <<'LOCAL_ASSETS'
import json
import sys
from pathlib import Path

assets = Path("dist/client/assets")
files = sorted(path.relative_to(assets).as_posix() for path in assets.rglob("*") if path.is_file())
if not files:
    raise SystemExit("Missing frontend assets. Build before deploying.")
Path(sys.argv[1]).write_text(json.dumps(files))
LOCAL_ASSETS

"${SSH_BASE[@]}" "$MINI_HOST" "mkdir -p '$REMOTE_APP/dist/client/assets' '$REMOTE_APP/.deploy' '$REMOTE_APP/src/lib' '$REMOTE_APP/src/server' '$REMOTE_APP/src/types' '$REMOTE_APP/packages/shared' '$REMOTE_APP/cache'"

update_client_assets() {
  "${SSH_BASE[@]}" "$MINI_HOST" "REMOTE_APP='$REMOTE_APP' python3 - '$1'" <<'REMOTE_ASSETS'
import json
import os
import sys
from pathlib import Path, PurePosixPath

root = Path(os.environ["REMOTE_APP"])
assets = root / "dist/client/assets"
state_file = root / ".deploy/client-assets.json"

def checked_files(value):
    if not isinstance(value, list) or any(
        not isinstance(name, str) or not name or PurePosixPath(name).is_absolute()
        or ".." in PurePosixPath(name).parts
        for name in value
    ):
        raise SystemExit("Invalid frontend asset manifest; refusing to prune.")
    return sorted(set(value))

if state_file.exists():
    state = json.loads(state_file.read_text())
    current = checked_files(state["current"])
    previous = checked_files(state["previous"])
else:
    # Bootstrap from the deployment that is currently serving index.html.
    current = sorted(path.relative_to(assets).as_posix() for path in assets.rglob("*") if path.is_file())
    previous = []

if sys.argv[1] == "publish":
    incoming = checked_files(json.loads((root / ".deploy/client-assets.next.json").read_text()))
    if not incoming or any(not (assets / name).is_file() for name in incoming):
        raise SystemExit("Frontend asset upload incomplete; refusing to prune.")
    # A retry of the same build is not a new release: retain its predecessor.
    if incoming != current:
        previous, current = current, incoming

temporary = state_file.with_suffix(".tmp")
temporary.write_text(json.dumps({"current": current, "previous": previous}))
temporary.replace(state_file)

if sys.argv[1] == "publish":
    retained = set(current) | set(previous)
    removed = 0
    for path in assets.rglob("*"):
        if path.is_file() and path.relative_to(assets).as_posix() not in retained:
            path.unlink()
            removed += 1
    for path in sorted(assets.rglob("*"), reverse=True):
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()
    print(f"Frontend assets: {len(current)} current, {len(previous)} previous, {removed} expired files removed")
REMOTE_ASSETS
}

# Publish chunks before HTML. Excluding this directory from --delete protects
# the previous release until the explicit two-release manifest is committed.
update_client_assets prepare
rsync -a -e "$RSYNC_SSH" dist/client/assets/ "$MINI_HOST:$REMOTE_APP/dist/client/assets/"
rsync -a -e "$RSYNC_SSH" "$SPOTIFY_DEPLOY_TMP/client-assets.next.json" "$MINI_HOST:$REMOTE_APP/.deploy/"
rsync -a --checksum --delete --exclude='/client/assets/' -e "$RSYNC_SSH" dist/ "$MINI_HOST:$REMOTE_APP/dist/"
update_client_assets publish

rsync -a --delete -e "$RSYNC_SSH" src/lib/ "$MINI_HOST:$REMOTE_APP/src/lib/"
rsync -a --delete -e "$RSYNC_SSH" src/server/ "$MINI_HOST:$REMOTE_APP/src/server/"
rsync -a --delete -e "$RSYNC_SSH" src/types/ "$MINI_HOST:$REMOTE_APP/src/types/"
rsync -a --delete -e "$RSYNC_SSH" packages/shared/ "$MINI_HOST:$REMOTE_APP/packages/shared/"
rsync -a -e "$RSYNC_SSH" package.json bun.lock tsconfig.json "$MINI_HOST:$REMOTE_APP/"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  "${SSH_BASE[@]}" "$MINI_HOST" "cd '$REMOTE_APP' && '$BUN_BIN' install --production --frozen-lockfile"
  "$ROOT_DIR/scripts/install-mini-server.sh"
  # The Mac mini shares one Caddy daemon with StreamArena. Re-merge Spotify's
  # marked host block on every deploy so a rebuilt shared config cannot leave
  # the native app with cached library data but no reachable streaming origin.
  "$ROOT_DIR/scripts/install-mini-caddy.sh"
  "$ROOT_DIR/scripts/check-mini.sh"
fi
