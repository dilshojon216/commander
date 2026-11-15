#!/bin/bash
# Qatlam chegarasini tekshiradi (docs/NATIVE-DASHBOARD.md, 3.1 va 6-bo'lim).
#   1) DashboardCore: SwiftUI/AppKit/Combine import QILINMAYDI (UI'siz mantiq).
#   2) DashboardUI: tarmoq/jarayon chaqiruvi YO'Q (URLSession, Process, WebSocket) — ma'lumot view model orqali keladi.
#   3) Taqiqlar: force unwrap emas, `try!` (testdan tashqari) va `fatalError(` Core/UI da bo'lmasligi.
#   4) 300 qatordan uzun fayllar ro'yxati (ogohlantirish; --strict bilan xato).
# Foydalanish: scripts/check-layers.sh [--strict]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/Sources/DashboardCore"
UI="$ROOT/Sources/DashboardUI"
STRICT=false
[ "${1:-}" = "--strict" ] && STRICT=true
fail=0

report() { echo "XATO: $1"; fail=1; }

if [ -d "$CORE" ]; then
  hits=$(grep -rnE '^\s*(@_exported\s+)?import\s+(SwiftUI|AppKit|UIKit|Combine)\b' "$CORE" || true)
  [ -z "$hits" ] || report "DashboardCore da UI importi taqiqlangan:"$'\n'"$hits"
fi

if [ -d "$UI" ]; then
  hits=$(grep -rnE '\b(URLSession|URLRequest|Process\(\)|NSTask|URLSessionWebSocketTask)\b' "$UI" || true)
  [ -z "$hits" ] || report "DashboardUI da tarmoq/jarayon chaqiruvi taqiqlangan (view model orqali oling):"$'\n'"$hits"
fi

for dir in "$CORE" "$UI"; do
  [ -d "$dir" ] || continue
  hits=$(grep -rnE '\btry!|\bfatalError\(' "$dir" || true)
  [ -z "$hits" ] || report "try!/fatalError taqiqlangan:"$'\n'"$hits"
done

long=$(find "$ROOT/Sources" -name '*.swift' -print0 | xargs -0 wc -l | awk '$2 != "total" && $1 > 300 {print $1, $2}' | sed "s|$ROOT/||" | sort -rn)
if [ -n "$long" ]; then
  echo "OGOHLANTIRISH: 300 qatordan uzun fayllar (N0.12 da bo'linadi):"
  echo "$long" | sed 's/^/  /'
  $STRICT && fail=1
fi

if [ "$fail" -eq 0 ]; then echo "check-layers: toza"; fi
exit "$fail"
