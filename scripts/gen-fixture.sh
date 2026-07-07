#!/usr/bin/env bash
# Regenerate the Russian speech test fixture (tests/fixtures/sample-ru.wav).
# Requires: edge-tts (pip install edge-tts) and ffmpeg. Cleans up its own temp.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$here/tests/fixtures/sample-ru.wav"
tmp="$(mktemp -d -t dictum-fixture-XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

text="Так, мне нужно написать функцию на питоне, которая читает джейсон файл со списком пользователей и возвращает только активных. Ну и обработай ошибки, если файл не найден или битый."

echo "synthesizing speech (edge-tts)…"
edge-tts --voice ru-RU-DmitryNeural --text "$text" --write-media "$tmp/speech.mp3"

echo "transcoding to 16 kHz mono PCM16 → $out"
mkdir -p "$(dirname "$out")"
ffmpeg -hide_banner -loglevel error -y -i "$tmp/speech.mp3" \
  -ar 16000 -ac 1 -sample_fmt s16 -f wav "$out"

echo "done: $out"
