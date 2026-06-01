#!/usr/bin/env bash

DEFAULT_MINI_HOSTS=("m4mini-ts" "hermes@100.121.144.60" "m4mini.local" "hermes@192.168.1.240")

resolve_mini_host() {
  local hosts=()
  local timeout="${MINI_CONNECT_TIMEOUT:-5}"

  if [[ -n "${MINI_HOST:-}" ]]; then
    hosts=("$MINI_HOST")
  elif [[ -n "${MINI_HOSTS:-}" ]]; then
    local normalized_hosts="${MINI_HOSTS//,/ }"
    read -r -a hosts <<< "$normalized_hosts"
  else
    hosts=("${DEFAULT_MINI_HOSTS[@]}")
  fi

  local candidate
  for candidate in "${hosts[@]}"; do
    if ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout="$timeout" "$candidate" true >/dev/null 2>&1; then
      MINI_HOST="$candidate"
      MINI_HOST_ADDRESS="$(
        ssh -G "$candidate" 2>/dev/null | awk '$1 == "hostname" {print $2; exit}'
      )"
      MINI_HOST_ADDRESS="${MINI_HOST_ADDRESS:-${candidate#*@}}"
      export MINI_HOST
      export MINI_HOST_ADDRESS
      if [[ "$MINI_HOST_ADDRESS" != "$MINI_HOST" ]]; then
        printf 'Using Mac mini host: %s (%s)\n' "$MINI_HOST" "$MINI_HOST_ADDRESS" >&2
      else
        printf 'Using Mac mini host: %s\n' "$MINI_HOST" >&2
      fi
      return 0
    fi
  done

  printf 'Could not connect to any Mac mini host:' >&2
  printf ' %s' "${hosts[@]}" >&2
  printf '\n' >&2
  return 1
}
