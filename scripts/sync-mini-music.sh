#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
SOURCE_DIR="${SOURCE_DIR:-$HOME/Music}"
REMOTE_MUSIC_DIR="${REMOTE_MUSIC_DIR:-/Users/hermes/Music}"

usage() {
  cat <<'USAGE'
Usage: scripts/sync-mini-music.sh [options]

Syncs audio files plus cover/lyrics/sidecar files to the Mac mini music source.
The source files are copied, not deleted.

Options:
  --source <path>        Local source directory. Default: ~/Music.
  --remote-dir <path>    Remote music source. Default: /Users/hermes/Music.
  -h, --help             Show this help.

Environment:
  MINI_HOST              Default: hermes@m4mini.local
  SSH_KEY                Default: ~/.ssh/id_ed25519_codex_m4mini
  SOURCE_DIR             Default: ~/Music
  REMOTE_MUSIC_DIR       Default: /Users/hermes/Music
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      [[ $# -ge 2 ]] || { echo "--source requires a path" >&2; exit 2; }
      SOURCE_DIR="$2"
      shift 2
      ;;
    --remote-dir)
      [[ $# -ge 2 ]] || { echo "--remote-dir requires a path" >&2; exit 2; }
      REMOTE_MUSIC_DIR="$2"
      shift 2
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

[[ -d "$SOURCE_DIR" ]] || { echo "Source directory not found: $SOURCE_DIR" >&2; exit 1; }

ssh -i "$SSH_KEY" -o BatchMode=yes "$MINI_HOST" "mkdir -p '$REMOTE_MUSIC_DIR'"

rsync -a --human-readable --progress --stats --prune-empty-dirs \
  -e "ssh -i $SSH_KEY -o BatchMode=yes" \
  --include='*/' \
  --include='*.[aA][aA][cC]' \
  --include='*.[aA][iI][fF]' \
  --include='*.[aA][iI][fF][fF]' \
  --include='*.[fF][lL][aA][cC]' \
  --include='*.[mM]4[aA]' \
  --include='*.[mM][pP]3' \
  --include='*.[oO][gG][aA]' \
  --include='*.[oO][gG][gG]' \
  --include='*.[oO][pP][uU][sS]' \
  --include='*.[wW][aA][vV]' \
  --include='*.[jJ][pP][gG]' \
  --include='*.[jJ][pP][eE][gG]' \
  --include='*.[pP][nN][gG]' \
  --include='*.[wW][eE][bB][pP]' \
  --include='*.[gG][iI][fF]' \
  --include='*.[lL][rR][cC]' \
  --include='*.[tT][xX][tT]' \
  --include='*.spotify.json' \
  --exclude='*' \
  "$SOURCE_DIR/" \
  "$MINI_HOST:$REMOTE_MUSIC_DIR/"

ssh -i "$SSH_KEY" -o BatchMode=yes "$MINI_HOST" \
  "find '$REMOTE_MUSIC_DIR' -type f \\( -iname '*.aac' -o -iname '*.aif' -o -iname '*.aiff' -o -iname '*.flac' -o -iname '*.m4a' -o -iname '*.mp3' -o -iname '*.oga' -o -iname '*.ogg' -o -iname '*.opus' -o -iname '*.wav' \\) | wc -l | tr -d ' ' | awk '{print \"remote_audio_files=\" \$1}'"
