# Commander: UI dizayn brifi

Holat 2026-11-13 dagi. Bu fayl Claude Desktop'da UI dizayn qilish uchun yozilgan. Dizayn tayyor bo'lgach, u Next.js 16 + Tailwind 4 da kodga o'giriladi.

---

## 1. Mahsulot nima

**Commander** bitta foydalanuvchi uchun "Claude Code boshqaruv markazi". Foydalanuvchi bir nechta kompyuter va serverda bir vaqtda o'nlab Claude Code sessiyalarini ishlatadi. Commander ularning hammasini bitta ekranga yig'adi:

- **Sessiyalar:** qayerda qaysi sessiya ishlayapti, javob kutyapti, ruxsat so'rayapti yoki tugagan.
- **Tokenlar:** loyiha, mashina va model bo'yicha, kunlik va umumiy hisobda.
- **Obuna limitlari:** 5 soatlik va haftalik oyna, foizda.
- **Ruxsat so'rovlari:** Claude "bu buyruqni bajaraymi?" deb so'raganda masofadan Ruxsat yoki Rad.
- **Rejada (2-bosqich):**
  - sessiya chatini jonli o'qish;
  - sessiyaga prompt yuborish va to'xtatish;
  - istalgan mashinada yangi sessiya ochish.

**Foydalanuvchi:** dasturchi. U kun bo'yi terminalda ishlaydi va dashboard'ni yonidagi ekranda ochiq tutadi. Interfeys ma'lumotga zich bo'lsin, tez o'qilsin va jonli yangilansin. Linear, Vercel dashboard yoki Grafana uslubiga yaqin. Bezakdan ko'ra aniqlik muhim.

**Til:** UI matnlari o'zbekcha (lotin). Texnik nomlar (model, tool, fayl yo'li) asl holida qoladi.

**Mavzu:** qorong'i va yorug' rejim, ikkalasi ham to'liq ishlashi kerak. Asosiy ish rejimi qorong'i.

---

## 2. Hozirgi holat (nima ishlayapti)

| Qism | Holat |
|---|---|
| Markaz (server, baza) | ✅ Mac'da ishlayapti |
| Mashinalar | ✅ 7 ta onlayn: Mac, Windows PC, 5 ta Ubuntu server |
| Sessiya holatlari | ✅ jonli (≈1 soniya kechikish) |
| Tokenlar | ✅ har so'rov bo'yicha, loyihaga bog'langan, Toshkent vaqti bilan kunlik |
| Limitlar | ✅ rasmiy raqam (status line'dan) va taxmin |
| Ruxsat so'rovlari | ✅ Mac'da ishlayapti, dashboard'dan Ruxsat/Rad |
| Web dashboard | ⚠️ ishlaydi, lekin dizayni oddiy, **qayta chizish kerak** |
| Telegram bot | ⏳ bot tokeni kutilmoqda |
| Chatni ko'rish | ⏳ 2-bosqich |
| Prompt yuborish, to'xtatish, yangi sessiya | ⏳ 2-bosqich |
| Loyiha rejasi (TASKS.md) va vazifa bo'yicha token | ⏳ 2-bosqich |
| Sessiyalararo xabar | ⏳ 2-bosqich oxiri |
| Mac menu-bar ilova, telefon (Flutter) | ⏳ 3-bosqich |

---

## 3. Ekranlar

### 3.1 Umumiy (bosh sahifa)
Bir qarashda: "hozir nima bo'lyapti va menga nima kerak?"

1. **Lockdown banneri.** Faqat lockdown yoqiq bo'lsa ko'rinadi: qizil, tepada yopishgan. Matni: "Lockdown yoqiq: masofadan faqat rad etish mumkin".
2. **Diqqat talab qiladi.** Eng yuqorida turadi.
   - Ruxsat kutayotgan so'rovlar. Har birida: mashina, loyiha, tool nomi, buyruqning qisqa ko'rinishi, qolgan vaqt (taymer) va **Ruxsat** / **Rad** tugmalari.
   - Javob kutayotgan sessiyalar (`waiting`).
3. **Limitlar kartasi.** Ikki oyna: "5 soat" va "Haftalik". Har birida foiz chizig'i, "15:40 da yangilanadi" (teskari sanoq) va "2 daqiqa oldin kuzatilgan".
4. **Tokenlar.** To'rtta raqam: Bugun, 7 kun, 30 kun, Jami. Ostida kichik izoh: "≈ $X API ekvivalenti".
5. **Mashinalar.** Kichik kartalar: nom, OS ikonkasi (mac/linux/windows), onlayn nuqtasi va sessiyalar soni holat bo'yicha (masalan "3 ishlamoqda · 1 kutmoqda").
6. **Aktiv sessiyalar.** Qisqa ro'yxat, "Hammasi →" havolasi bilan.
7. **Bugungi tokenlar loyiha bo'yicha.** Eng ko'p ishlatgan 5 ta loyiha.

### 3.2 Sessiyalar
- **Jadval yoki kartalar:** holat, loyiha, mashina, model, holat qancha vaqtdan beri, oxirgi xabar va ruxsat so'rovlari soni (belgi bilan).
- **Filtrlar:** holat, mashina, loyiha, qidiruv, "tugaganlarini ham ko'rsat".
- **"Aloqa yo'q" belgisi:** mashina oflayn bo'lsa sessiya kulrang bo'ladi va ⚠ belgisi chiqadi.
- Qatorni bossangiz sessiya sahifasiga o'tasiz.

### 3.3 Sessiya sahifasi (eng muhim yangi ekran)
Chat ilovasidek ko'rinadi:

- **Tepada:** loyiha, mashina, model, holat va boshlangan vaqt. Tugmalar: **To'xtatish** va **⋯**.
- **O'rtada: chat oqimi (2-bosqich).**
  - Foydalanuvchi promptlari.
  - Claude javoblari (markdown).
  - Tool chaqiruvlari yig'ib qo'yilgan bloklar ko'rinishida: `Bash: npm test`, `Edit: src/app.ts (+12 −3)`, `Read: …`. Bosilsa ochiladi.
  - Xatolar.
  - Token sarfi (har javob ostida kichik yozuv).
  - Yangi xabarlar jonli qo'shiladi va pastga avtomatik suriladi.
- **Ruxsat so'rovi** chat ichida alohida karta bo'lib chiqadi: buyruq, Ruxsat/Rad tugmalari va taymer.
- **Pastda: prompt maydoni (2-bosqich).** Matn yozib "Yuborish" bosiladi. Agar sessiyani boshqarib bo'lmasa, maydon o'chiq turadi va sababini tushuntiradi (masalan "terminal sessiyasi, faqat ko'rish").
- **O'ng panel (ixtiyoriy):**
  - sessiya tokenlari;
  - holat tarixi (vaqt chizig'i);
  - o'zgargan fayllar ro'yxati.

### 3.4 Yangi sessiya oynasi (2-bosqich)
Modal oyna. Maydonlar:
- **Mashina:** faqat onlayn mashinalar.
- **Papka:** ruxsat etilgan ro'yxatdan.
- **Vazifa matni.**
- **Model.**
- **Ruxsat rejimi.**

"Ochish" bosilgach: "Telegram'da tasdiqlang" holati chiqadi (ikkinchi tasdiq), keyin sessiya sahifasiga o'tiladi.

### 3.5 Loyihalar
- **Jadval:** loyiha, mashina, bugungi va jami tokenlar, so'rovlar soni, ochiq sessiyalar va oxirgi ishlatilgan vaqt. Saralanadi.
- **Loyiha sahifasi:**
  - 30 kunlik token grafigi;
  - sessiyalar ro'yxati;
  - git commitlar, `TODOS.md`, `CHANGELOG.md`;
  - **(2-bosqich)** `TASKS.md` rejasi: vazifalar holati bo'yicha (bajarildi / jarayonda / qoldi), progress chizig'i va har vazifaga ketgan token hamda vaqt.

### 3.6 Tokenlar (analitika)
- **Ustunli grafik (stacked):** davr 5 daqiqa / 1 soat / 1 kun, guruhlash loyiha / mashina / model bo'yicha, vaqt oralig'i tanlanadi.
- Grafik ostida jadval ko'rinishi.
- **Token turlari:** input, output, cache read, cache write. Cache read juda katta bo'ladi (jami tokenning ≈99%), shuning uchun turlarni alohida ko'rsatish yoki filtrlash imkoni kerak.

### 3.7 Mashinalar
- **Har mashina:** nom, OS, onlayn/oflayn, qachondan beri, agentd va Claude versiyasi, sessiyalar soni va bugungi tokenlar.
- Oflayn mashina aniq ajralib turishi kerak.

---

## 4. Holatlar va ularning ko'rinishi (dizaynda albatta hisobga olinsin)

### Sessiya holati
| Qiymat | UI matni | Ma'nosi | Tavsiya rang |
|---|---|---|---|
| `working` | Ishlamoqda | Claude ishlayapti | ko'k, jonli animatsiya |
| `waiting` | Javob kutmoqda | foydalanuvchidan javob kerak | sariq |
| `awaiting_approval` | Ruxsat kutmoqda | ruxsat so'rovi navbatda | to'q sariq yoki qizil, eng ko'zga tashlanadigan |
| `idle` | Bo'sh | ochiq, lekin ish yo'q | kulrang |
| `done` | Tugatdi | javob berib bo'ldi | yashil |
| `ended` | Yopilgan | sessiya yopilgan | xira |
| + `staleSince` | Aloqa yo'q | mashina oflayn | kulrang + ⚠ |

### Limit kartasi: 4 holat
1. **Rasmiy (`official`):** aniq raqam, masalan "8%", oddiy rangda.
2. **Taxmin (`estimate`):** "≈12%". Kulrang yoki shtrixli ko'rinish va "taxmin" yorlig'i bo'ladi. **Taxminni rasmiy raqamdek ko'rsatish mumkin emas.**
3. **Eskirgan (`stale`):** "3 soat oldin kuzatilgan", rangi xiralashadi.
4. **Yangilangan (`reset`):** oyna qayta boshlangan. "≈0% · yangilandi" ko'rinishida.

Chegaralar: 80% dan oshsa sariq, 95% dan oshsa qizil.

### Ruxsat so'rovi
`pending` → `approved` / `denied` / `expired` / `cancelled`.
- Taymer bor, 5 daqiqagacha.
- "Ruxsat" bosilganda tasdiqlash so'raladi.
- Javob kelgandan keyin karta holatni ko'rsatib xiralashadi.
- Xato holatlari:
  - "Allaqachon hal qilingan (terminalda javob berildi)";
  - "Lockdown: faqat rad etish mumkin".

### Ulanish
- Dashboard jonli oqimga ulangan: kichik yashil nuqta va "Jonli".
- Ulanish uzilgan: "Qayta ulanmoqda…".

---

## 5. Ma'lumot (har elementda nima bor)

Maydonlar API'dan aynan shu nomlar bilan keladi (camelCase).

**Mashina:** `displayName`/`hostname`, `os` (`darwin` | `linux` | `win32`), `online`, `lastSeenAt`, `agentdVersion`, `claudeVersion`, `sessions{open, working, waiting, awaitingApproval, idle, done}`.
> Hozir `slug` juda uzun (xesh qo'shilgan), UI'da `hostname` yoki `displayName` ko'rsatilsin.

**Sessiya:** `projectName`, `machineName`, `cwd`, `status`, `statusSince`, `startedAt`, `lastSeenAt`, `endedAt`, `endReason`, `model`, `message` (oxirgi bildirishnoma matni), `staleSince`, `pendingApprovals`, `kind` (interaktiv / fon).

**Loyiha:** `name`, `path`, `machineSlug`, `kind` (git | dir), `today{…}`, `allTime{…}`, `openSessions`, `lastUsedAt`.

**Token jami (TokenTotals):** `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `totalTokens`, `requests`, `costUsd`. `costUsd` obunada haqiqiy to'lov emas, "API ekvivalenti" deb ko'rsatiladi.

**Limit oynasi:** `usedPct`, `resetsAt`, `observedAt`, `source` (official | estimate), `stale`, `ageSeconds`, `reset`.

**Ruxsat so'rovi:** `toolName`, `toolInputRedacted` (maxfiy qismlari `[REDACTED]` bilan yashirilgan buyruq yoki JSON), `cwd`, mashina, sessiya, `deadline`, `status`.

**Chat xabari (2-bosqich, taxminiy):** `role` (user | assistant | tool), `text` (markdown), `toolName`, `toolInput` (qisqa), `toolResult` (qisqa, yig'iladi), `ts`, `tokens`.

### Namuna (haqiqatga yaqin raqamlar)
- Bugun: 67.6M token (cache read 67.1M, output 140K, input 391), 174 so'rov.
- Haftalik limit: 8% (rasmiy). 5 soatlik: ≈0% (yangilangan).
- 7 mashina onlayn, 8 aktiv sessiya: 3 ishlamoqda, 1 javob kutmoqda, 2 tugatdi, 2 bo'sh.
- Loyihalar: `commander`, `backend-services`, `mobile-app`, `web-app`, `demo_flow_ai`, `acme_app_ai`, `smart_well` va boshqalar.

---

## 6. Navigatsiya va layout
- **Chap sidebar:** Umumiy, Sessiyalar, Loyihalar, Tokenlar, Mashinalar. Har birida soni ko'rsatiladi, masalan Sessiyalar (8), ruxsat kutayotganlar bo'lsa qizil belgi.
- **Tepada:**
  - jonli ulanish belgisi;
  - lockdown holati;
  - "+ Yangi sessiya" tugmasi (2-bosqich);
  - mavzu almashtirgich.
- **Ekran o'lchami:** asosiy ish 1440px+ ekran. Planshet va telefonda ham o'qilishi kerak (telefon ilovasi keyin alohida bo'ladi).
- **Klaviatura:**
  - `g s` → sessiyalar;
  - `/` → qidiruv;
  - ruxsat kartasida `a` → ruxsat, `d` → rad (ruxsat uchun tasdiq so'raladi).

---

## 7. Cheklovlar (dizaynda buzilmasin)
1. **Maxfiylik:** buyruq yoki chatda yashirilgan joylar `[REDACTED]` bo'lib keladi. Ularni ko'rsatish uchun "ochish" tugmasi bo'lmaydi.
2. **Taxmin ≠ rasmiy:** limitda `estimate` doim "≈" belgisi va boshqa uslub bilan ko'rsatiladi.
3. **Xavfli amallar** ikki bosqichli: ruxsat berish, to'xtatish va yangi sessiya ochish tasdiq oynasi orqali o'tadi.
4. **Hammasi jonli:** sahifani yangilash tugmasi kerak emas, ma'lumot o'zi yangilanadi.
5. **Ko'p sessiya:** bir vaqtda 20–40 tagacha sessiya bo'lishi mumkin, ro'yxat shuni ko'tarsin.

---

## 8. Reja (keyingi bosqichlar)

| Bosqich | Nima | Holat |
|---|---|---|
| 1 | Kuzatish, tokenlar, limitlar, ruxsat, dashboard | ✅ (Telegram bot qoldi) |
| 1.8 | Telegram bot: bildirishnoma, Ruxsat/Rad, `/status`, `/usage` | ⏳ bot tokeni kerak |
| 2 | **Chatni jonli ko'rish** | ⏳ |
| 2 | Prompt yuborish, to'xtatish, yangi sessiya ochish | ⏳ |
| 2 | **Yangi dizayn** (shu brif bo'yicha) | ⏳ |
| 2.8–2.9 | Loyiha rejasi (`TASKS.md`) va vazifa bo'yicha token/vaqt | ⏳ |
| 2.10 | Sessiyalararo xabar (frontend ↔ backend sessiyalar) | ⏳ |
| 3 | Mac menu-bar ilova, telefon ilovasi (Flutter) | ⏳ |
| 4 | Mustahkamlash (zaxira nusxa, xavfsizlik, tarmoq qoidalari) | ⏳ |

**Ochiq qaror:** chat matni markazda saqlansinmi (7 kun) yoki faqat jonli oqim bo'lsinmi? Tavsiya: faqat jonli oqim. Dizayn ikkala holatga ham mos kelsin: mashina oflayn bo'lsa "Chat mavjud emas: mashina oflayn" holatini ham chizing.

---

## 9. Dizayndan kerak bo'ladigan narsa
- Yuqoridagi 7 ta ekran (3.1–3.7), qorong'i va yorug' rejimda.
- Komponentlar: holat belgisi, limit kartasi (4 holat), ruxsat kartasi (barcha holatlar), mashina kartasi, chat xabarlari (user, assistant, tool bloki, xato, ruxsat kartasi), prompt maydoni (faol / o'chiq), bo'sh holatlar ("sessiya yo'q"), yuklanish va xato holatlari.
- Rang tokenlari, tipografiya, oraliqlar. Kodga o'tkazishda shular Tailwind tokenlariga aylantiriladi.
