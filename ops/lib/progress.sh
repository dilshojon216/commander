# Jarayon markerlari (native dashboard ustasi child process chiqishidan o'qiydi): `COMMANDER_PROGRESS=1` bo'lsagina stderr'ga yoziladi,
# aks holda skriptlar chiqishi avvalgidek. Markerlarda HECH QACHON sir (enrollment kodi, token, kalit) bo'lmaydi.
#   ##commander-step <k>/<N> <sarlavha>
#   ##commander-result <bir qatorli JSON>
# Foydalanish: . "<ops>/lib/progress.sh"; commander_step 1 7 "Sarlavha"; commander_result "$(json_object machineName "$NAME" status success)"

commander_step() {
  [ "${COMMANDER_PROGRESS:-}" = "1" ] || return 0
  echo "##commander-step $1/$2 $3" >&2
}

commander_result() {
  [ "${COMMANDER_PROGRESS:-}" = "1" ] || return 0
  echo "##commander-result $1" >&2
}

# JSON satr qiymati uchun qochirish: teskari chiziq, qo'shtirnoq va boshqaruv belgilari (JSON buzilmasin, in'ektsiya bo'lmasin).
json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# json_object kalit1 qiymat1 kalit2 qiymat2 ... -> {"kalit1":"qiymat1",...} (bo'sh qiymatli juftlar tashlanadi)
json_object() {
  local out="" key value
  while [ $# -ge 2 ]; do
    key="$1"; value="$2"; shift 2
    [ -n "$value" ] || continue
    out="${out:+$out,}\"$(json_escape "$key")\":\"$(json_escape "$value")\""
  done
  printf '{%s}' "$out"
}
