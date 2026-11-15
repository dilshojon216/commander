# Tailscale (task 0.3)

Holat 2026-11-13 da tekshirildi: Tailscale 1.96.5, MagicDNS yoqiq, tailnet `<tailnet>.ts.net`.
Mac: `<mac>.<tailnet>.ts.net` (<mac-tailscale-ip>). Linux serverlar
(smart, acmeapp-ai, testserver, erpnext, agent, ubuntu20 va boshqalar) `tailscale ping`
bilan to'g'ridan-to'g'ri (LAN orqali) javob beradi. Hech bir qurilmada tag yo'q.

## Qaror: hozir ACL o'zgartirilmaydi

PLAN.md `tag:agent → tag:center` qoidasini taklif qiladi. Lekin:

- tag qo'yilgan qurilma foydalanuvchiga tegishli bo'lmay qoladi va faqat ACL'da yozilgan
  narsaga kira oladi;
- serverlar o'rtasidagi mavjud ulanishlar (SSH, backup, servislararo trafik) hali ro'yxatga
  olinmagan. Qattiq ACL ularni jimgina uzib qo'yishi mumkin.

Shuning uchun 0.3 da:

1. ACL va tag'larga tegilmaydi. Tailnet hozirgidek "egasining hamma qurilmasi bir-biriga
   kira oladi" holatida qoladi.
2. Markaz faqat `127.0.0.1:4317` da tinglaydi va tailnet'ga `tailscale serve` orqali HTTPS
   bilan chiqariladi. LAN'ga va internetga ochilmaydi (Funnel ishlatilmaydi).
3. Asosiy himoya ilova darajasida: qurilma kalitlari, imzolangan buyruqlar, client
   tokenlar (task 0.6). Tailnet'dagi istalgan qurilma `/health` ga yeta oladi, lekin
   imzosiz so'rovga 401 oladi.

ACL'ni qattiqlashtirish 4-fazaga ko'chiriladi (pastdagi loyiha).

## Markazni tailnet'ga chiqarish (Mac'da, center ishga tushgach)

```sh
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
# center 127.0.0.1:4317 da ishlayotgan bo'lishi kerak
$TS serve --bg --https=443 http://127.0.0.1:4317
$TS serve status
```

Natija: `https://<mac>.<tailnet>.ts.net/` → center. Sertifikatni
Tailscale o'zi beradi. O'chirish: `$TS serve --https=443 off`.

Muhim: center'ning `docker-compose.yml` ida port `"127.0.0.1:4317:4317"` ko'rinishida
bog'langan bo'lishi kerak. `"4317:4317"` bo'lsa, center Wi-Fi/LAN'dagi hammaga ochiq bo'ladi
(task 0.4 da tuzatiladi).

## Qabul tekshiruvi (0.3)

Har qanday Linux serverdan:

```sh
curl -s https://<mac>.<tailnet>.ts.net/health   # → {"ok":true}
```

Tailnet tashqarisidan (masalan, telefonda Tailscale o'chiq holda) manzil ochilmasligi kerak.

## 4-faza: ACL'ni qattiqlashtirish (hali qo'llanmaydi)

Avval inventar: har bir serverda `ss -tnp state established` va `tailscale status` orqali
qaysi server qaysi tailnet IP'ga ulanayotganini yozib chiqish. Keyin admin konsolda
(Access controls) quyidagiga o'xshash siyosat qo'llanadi. Bu qoralama: saqlashdan oldin
konsolning "Preview rules" bo'limida har bir qatorni tekshirish kerak. Mac va telefon tag'lanmaydi:
ular foydalanuvchiniki bo'lib qoladi.

```hujson
{
  "tagOwners": {
    "tag:agent": ["autogroup:admin"]
  },
  "grants": [
    // Foydalanuvchining shaxsiy qurilmalari (Mac, telefon, Windows) hamma joyga.
    { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
    // Serverlar markazga (Mac, faqat HTTPS serve porti).
    { "src": ["tag:agent"], "dst": ["<you@example.com>"], "ip": ["tcp:443"] }
    // + inventarda topilgan har bir serverlararo ulanish uchun alohida qator.
  ]
}
```

Qo'llash tartibi: bitta serverni `sudo tailscale up --advertise-tags=tag:agent` bilan
tag'lash, uning barcha xizmatlari ishlashini tekshirish, keyin qolganlarini bittalab.
`tailscale up` qayta chaqirilganda boshqa flag'lar (`--advertise-exit-node` va h.k.) ham
qayta berilishi kerak, aks holda ular o'chib qoladi (smartchannel, testserver exit node
taklif qiladi).

## Qamrovdan tashqarida

- Windows qurilma (`<win-hostname>`): PLAN faqat macOS va Ubuntu uchun agentd'ni
  rejalashtiradi.
- Android telefon (`Xiaomi 12 Lite`, hozir offline): Flutter ilova 3-fazada; telefon
  tailnet orqali ulanadi.
