# Deploy retsepti (`.commander/deploy.yml`) — namuna va qoidalar (TASKS 6.5)

Retsept **repo ichida** turadi (kod bilan versiyalanadi, kod kabi ko'rib chiqiladi). Commander uni mijozdan (dashboard/Telegram) HECH QACHON
qabul qilmaydi: mashinadagi `agentd` retseptni **commit qilingan** nusxadan (`git cat-file blob <sha>:.commander/deploy.yml`, ishchi daraxt
emas) o'qiydi, normallashtiradi va sha256 xeshini egasiga ko'rsatadi. Egasi aniq **(maqsad, commit, retsept xeshi)** uchlikni tasdiqlaydi;
agentd ijro oldidan retseptni qayta o'qiydi va xesh yoki HEAD o'zgargan bo'lsa rad etadi (`recipe_changed` / `commit_changed`).

## Namuna

```yaml
version: 1
targets:
  prod:                       # maqsad nomi: [a-z0-9._-], <= 40
    machine: ubuntu-prod      # markazdagi mashina slug'i; boshqa mashinada deploy rad etiladi (machine_mismatch)
    cwd: .                    # repo ildiziga nisbatan yoki policy.allowedRoots ichidagi mutlaq yo'l ("~" yo'q, ".." yo'q)
    timeout: 1800             # butun deploy muddati, soniya (default 1800, <= 7200)

    preflight:                # tekshiruvlar: birortasi muvaffaqiyatsiz bo'lsa deploy boshlanmaydi (rollback ham yo'q)
      - name: tests
        run: [npm, test]
      - [git, diff, --quiet] # qisqa shakl: nomsiz argv massivi ("preflight 2" nomi beriladi)

    steps:                    # ketma-ket; har biri ARGV MASSIVI (shell yo'q)
      - name: install
        run: [npm, ci]
        timeout: 600          # qadam muddati, soniya (default 300, <= 3600)
      - name: build
        run: [npm, run, build]
        env: { NODE_ENV: production, APP_COMMIT: "{{commit}}" }   # faqat A-Z0-9_ nomlar
      - name: restart
        run: [systemctl, --user, restart, myapp]
        cwd: deploy           # target cwd ichidagi nisbiy papka

    health:                   # (ixtiyoriy) deploydan keyin
      url: http://127.0.0.1:3000/health   # yoki: run: [./scripts/check.sh]  (exit 0 = sog'lom)
      expect: [200, 204]      # default [200]
      retries: 10             # qo'shimcha urinishlar (jami 1 + retries)
      interval: 3             # urinishlar orasi, soniya
      timeout: 5              # bitta urinish, soniya

    rollback:                 # (ixtiyoriy) xato bo'lsa AVTOMATIK, yoki dashboard/Telegram "Rollback" tugmasi bilan
      - name: previous release
        run: [./scripts/rollback.sh, "{{short_commit}}"]
```

### O'rinbosarlar
Faqat `{{commit}}` (to'liq sha), `{{short_commit}}` (8 belgi), `{{target}}` — argv, env qiymatlari, health URL va `shell:` matnida.
Boshqa `{{...}}` retseptni yaroqsiz qiladi. Qadamlar muhitiga qo'shimcha: `COMMANDER_DEPLOY=1`, `COMMANDER_DEPLOY_TARGET`,
`COMMANDER_DEPLOY_COMMIT`, `COMMANDER_DEPLOY_PHASE`.

### Shell (ixtiyoriy, ikki marta opt-in)
`shell:` qatori (`sh -c`) faqat retsept o'zi `shell:` kalitini ishlatsa **va** mashinada `agentd policy allow-deploy-shell` yoqilgan bo'lsa
ishlaydi (default o'chiq, aks holda `shell_not_allowed`). `run: [bash, -c, "..."]`, `env sh ...`, `sudo bash ...` ham shell hisoblanadi.
```yaml
      - name: bundle
        shell: "npm ci && npm run build"   # allowDeployShell kerak
```

## Qoidalar va cheklovlar
- `run` — MASSIV (qator berilsa retsept yaroqsiz). Birinchi element buyruq nomi/yo'li (bo'shliqsiz, `-` bilan boshlanmaydi). Nom PATH'dan
  ishonchli ro'yxat bo'yicha topiladi (loyiha papkasi chiqarib tashlanadi); `./x` kabi nisbiy yo'l qadam cwd'si ichida bo'lishi shart.
- Noma'lum kalit rad etiladi (imlo xatosi jim o'tmasin). YAML faqat core schema (teg/merge yo'q); fayl <= 64 KB; alias bombasi rad.
- Sirga o'xshash qiymat (token/parol/kalit) retseptda rad etiladi: sirlarni mashinadagi muhitdan oling (env). `PATH`, `LD_*`, `DYLD_*`, `GIT_*`,
  `NODE_*`, `NPM_*`, `HOME`, `SHELL`, `BASH_ENV` ... retsept env'ida taqiqlangan; agentd o'z `COMMANDER_*`/`AGENTD_*` sirlarini bolalarga bermaydi.
- Ishchi daraxtda commit qilinmagan **kuzatiladigan** o'zgarish bo'lsa deploy rad etiladi (`dirty_worktree`): deploy qilinadigan kod = ko'rib chiqilgan commit.
  Qadamlar `git pull`/`checkout` qilsa HEAD siljishi mumkin: pin faqat BOSHLANISHDA tekshiriladi (`{{commit}}` bilan aniq commit'ga o'ting).
- Health HTTP: faqat `http(s)`, URL ichida login/parol yo'q, redirect kuzatilmaydi, tana o'qilmaydi (faqat status kodi).
- Bir maqsadga bir vaqtda bitta deploy/rollback (`deploy_busy`). Qadam muddati tugasa jarayon guruhi o'ldiriladi (SIGTERM, 5 s dan keyin SIGKILL).
- Chiqish redakt qilinadi, jonli ko'rinadi (<= 8 MB, ortig'i tashlanadi) va **hech qayerda saqlanmaydi**; tarixda faqat qadam nomlari/holatlari/vaqtlari.

## Yoqish (mashinada, bir marta)
```bash
agentd policy allow-root /path/to/repo       # loyiha ildizi allaqachon ruxsat etilgan bo'lishi shart
agentd policy allow-deploy                   # default O'CHIQ
agentd policy allow-deploy-shell             # faqat retsept `shell:` ishlatsa
agentd policy deny-deploy                    # o'chirish (shell'ni ham o'chiradi)
```
Dashboard: loyiha sahifasi -> **Deploy** (retseptni tekshirish, har buyruq va xesh ko'rinadi, tarix, jonli chiqish, Rollback). Har deploy/rollback:
Telegram ikkinchi tasdig'i HAR DOIM (Mac dashboard istisnosi ham o'tmaydi), dashboard elevation (Touch ID/parol) majburiy, audit, lockdown'da bloklanadi.
