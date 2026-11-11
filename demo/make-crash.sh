#!/usr/bin/env bash
# Airbag "crash test" video: record the real app (NEAR testnet + Polygon Amoy) → speed up waits → compose → render.
# Needs the web app on :3108 (web: next start -p 3108) and the keeper running (it signs + broadcasts the Polygon split).
#   bash demo/make-crash.sh            full run (a real 100 USDC buy on NEAR testnet by the test account alice)
#   bash demo/make-crash.sh --compose  re-compose + render from the last take (no new buy)
set -euo pipefail
cd "$(dirname "$0")/.."
SKILL=.claude/skills/hyperframes-app-demo/scripts
TAKE=demo-video/crash-take; PROJ=demo-video/crash; OUT=demo-video/airbag-crash.mp4
if [[ ${1:-} != --compose ]]; then
  rm -rf "$TAKE"
  (cd demo && CAPTIONS=0 PACE=1.3 node "../$SKILL/record.mjs" --scenario crash-scenario.mjs --base-url http://localhost:3108 \
    --out "../$TAKE" --viewport 1600x900 --scale 2)
  node "$SKILL/edit.mjs" --out "$TAKE"
fi
node demo/compose-crash.mjs --take "$TAKE" --project "$PROJ"
(cd "$PROJ" && npx --yes hyperframes@0.8.78 check 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "error\(s\)|Check (passed|failed)" || true)
(cd "$PROJ" && npx --yes hyperframes@0.8.78 render -o "../$(basename "$OUT")" --fps 30 --quality high --video-frame-format png -w 1 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | grep -E "MB ·|rror" || true)
mkdir -p demo-video/crash-check; rm -f demo-video/crash-check/*.png
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
for f in 0.03 0.09 0.17 0.27 0.36 0.45 0.55 0.65 0.75 0.85 0.93 0.98; do t=$(awk "BEGIN{printf \"%.1f\", $DUR*$f}"); ffmpeg -v error -y -ss "$t" -i "$OUT" -frames:v 1 -vf scale=960:-1 "demo-video/crash-check/t$t.png"; done
printf '\n✅ %s (%.0fs) · frames: demo-video/crash-check/\n' "$OUT" "$DUR"
