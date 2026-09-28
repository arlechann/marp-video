#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
  printf 'Usage: %s [docker|podman]\n' "$0" >&2
  exit 2
fi

runtime="${1:-}"
case "$runtime" in
  '')
    if command -v docker >/dev/null 2>&1; then
      runtime=docker
    elif command -v podman >/dev/null 2>&1; then
      runtime=podman
    else
      printf 'Docker or Podman is required to start VOICEVOX.\n' >&2
      exit 1
    fi
    ;;
  docker|podman)
    if ! command -v "$runtime" >/dev/null 2>&1; then
      printf '%s is not installed or is not on PATH.\n' "$runtime" >&2
      exit 1
    fi
    ;;
  *)
    printf 'Usage: %s [docker|podman]\n' "$0" >&2
    exit 2
    ;;
esac

printf 'Starting VOICEVOX with %s at http://127.0.0.1:50021\n' "$runtime" >&2
exec "$runtime" run --rm -p '127.0.0.1:50021:50021' voicevox/voicevox_engine:cpu-latest
