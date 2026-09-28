#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
  printf 'Usage: %s [voicevox-url]\n' "$0" >&2
  exit 2
fi
if [[ "${1:-}" == '--help' ]]; then
  printf 'Usage: %s [voicevox-url]\n' "$0"
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js is required to list VOICEVOX speakers.\n' >&2
  exit 1
fi

# Node.js is already required by marp-video; use its built-in fetch and JSON parser
# so this helper needs neither curl nor jq.
exec node --input-type=module - "${1:-http://127.0.0.1:50021}" <<'NODE'
const baseUrl = process.argv[2];

try {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('VOICEVOX URL は http または https で指定してください');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/speakers`;
  url.search = '';
  url.hash = '';

  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`VOICEVOX /speakers: HTTP ${response.status}`);
  const speakers = await response.json();
  if (!Array.isArray(speakers)) throw new Error('VOICEVOX /speakers の応答形式が不正です');

  const lines = speakers.flatMap(speaker => {
    if (typeof speaker?.name !== 'string' || !Array.isArray(speaker.styles)) {
      throw new Error('VOICEVOX /speakers の応答形式が不正です');
    }
    return speaker.styles.map(style => {
      if (typeof style?.name !== 'string' || !Number.isSafeInteger(style.id) || style.id < 0) {
        throw new Error('VOICEVOX /speakers の応答形式が不正です');
      }
      return `${style.id}\t${speaker.name}\t${style.name}`;
    });
  });
  process.stdout.write(['ID\t話者\tスタイル', ...lines].join('\n') + '\n');
} catch (reason) {
  process.stderr.write(`エラー: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  process.exitCode = 1;
}
NODE
