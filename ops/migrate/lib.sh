#!/bin/bash
# Commander ko'chirish/DR skriptlari uchun umumiy yordamchilar (source qilinadi, to'g'ridan-to'g'ri ishga tushirilmaydi).
# Ishlatadi: ops/migrate/{export,import,verify}-center.sh, ops/mac/backup-secrets.sh
#
# Xavfsizlik qoidalari (o'zgartirmang):
#   - passphrase HECH QACHON argv'da emas: openssl'ga `-pass fd:3` orqali, bash builtin `printf` bilan beriladi;
#   - shifr: openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt (macOS LibreSSL 3.3+ va Linux OpenSSL 3 mos);
#   - maxfiy fayllar 0600, kataloglar 0700 (umask 077);
#   - sir qiymatlari loglarga chiqmaydi: faqat checksum prefikslari, sanoqlar, fingerprint.

CMDR_CIPHER_ARGS=(-aes-256-cbc -pbkdf2 -iter 600000)
# Yordamchi konteyner (tar/sha256sum uchun). TimescaleDB image'i ham Alpine: alohida pull shart emas.
CMDR_TOOLBOX_IMAGE="${CMDR_TOOLBOX_IMAGE:-timescale/timescaledb:2.32.0-pg16}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# sha256 (macOS: shasum, Linux: sha256sum). Chiqish: "<hash>  <fayl>"
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
sha256_check() {  # checksums.txt'ni joriy katalogda tekshiradi
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$1"; else shasum -a 256 -c "$1"; fi
}
short_hash() { cut -c1-16; }

# GNU stat (-c) avval: GNU'da `stat -f` "fayl tizimi" rejimi bo'lib, stdout'ga axlat chiqaradi.
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# Passphrase'ni fayldan o'qiydi (0600 va bo'sh emas bo'lishi shart). Natija: PASSPHRASE o'zgaruvchisi.
read_passphrase_file() {
  local f="$1" mode
  [ -f "$f" ] || die "passphrase fayli topilmadi: $f"
  mode="$(file_mode "$f")"
  [ "$mode" = "600" ] || [ "$mode" = "400" ] || die "passphrase fayli 0600 (yoki 0400) bo'lishi shart, hozir: $mode"
  IFS= read -r PASSPHRASE < "$f" || true
  [ -n "$PASSPHRASE" ] || die "passphrase fayli bo'sh: $f"
}

# Interaktiv so'rash (faqat TTY). $1=1 bo'lsa ikki marta so'rab tasdiqlaydi.
prompt_passphrase() {
  local confirm="${1:-0}" again
  [ -t 0 ] || die "passphrase kerak: --passphrase-file FILE (0600) bering yoki terminaldan ishga tushiring"
  read -rsp "Passphrase: " PASSPHRASE; echo "" >&2
  [ -n "$PASSPHRASE" ] || die "passphrase bo'sh bo'lmasligi kerak"
  if [ "$confirm" = 1 ]; then
    read -rsp "Passphrase (qayta): " again; echo "" >&2
    [ "$PASSPHRASE" = "$again" ] || die "passphrase'lar mos emas"
  fi
}

# stdin -> shifrlangan stdout (yoki -in/-out argumentlari). Passphrase fd 3 orqali.
encrypt_stream() { openssl enc "${CMDR_CIPHER_ARGS[@]}" -salt -pass fd:3 "$@" 3< <(printf '%s' "$PASSPHRASE"); }
decrypt_stream() { openssl enc -d "${CMDR_CIPHER_ARGS[@]}" -pass fd:3 "$@" 3< <(printf '%s' "$PASSPHRASE"); }

require_openssl() {
  command -v openssl >/dev/null 2>&1 || die "openssl topilmadi"
  echo test | encrypt_stream >/dev/null 2>&1 || die "openssl -pbkdf2 -iter ni qo'llamaydi (LibreSSL >= 3.1 yoki OpenSSL >= 1.1.1 kerak)"
}

# Konteynerdagi berilgan yo'lga ulangan volume nomi.
container_volume() {  # $1=container id/nomi, $2=konteyner ichidagi yo'l
  docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Name}}{{end}}{{end}}" "$1"
}

# 5.7 (H-02): markaz imzo kalitini host imzolovchidan olayotgan bo'lsa (SIGNER_SOCKET), kalit volume'da bo'lmasligi mumkin.
center_uses_signer() {  # $1=app konteyner id/nomi
  docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^SIGNER_SOCKET=.'
}

# Volume ichidagi fayllar sha256 ro'yxati (volume faqat o'qish uchun ulanadi). Chiqish: "<hash>  <nom>" tartiblangan.
volume_checksums() {
  docker run --rm -v "$1":/v:ro "$CMDR_TOOLBOX_IMAGE" sh -c 'cd /v && find . -type f | sort | xargs -r sha256sum' 2>/dev/null
}
