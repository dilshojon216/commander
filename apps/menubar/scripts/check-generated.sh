#!/bin/bash
# Web manbasidan generatsiya qilingan Swift/test fayllari eskirmaganini tekshiradi (xato matnlari va elevation qoidalari).
# Eskirgan bo'lsa: tegishli `node scripts/gen-*.mjs` ni (--check'siz) ishga tushiring.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/gen-error-texts.mjs --check
node scripts/gen-elevation-rules.mjs --check
