# clients/ — kontraktdan generatsiya qilingan klient paketlari

`libs/contracts` (Zod) — yagona haqiqat manbai. Bu yerdagi modellar **qo'lda yozilmaydi**:

```
libs/contracts/src/*.ts  --z.toJSONSchema-->  libs/contracts/generated/json-schema/*.json
                                              --libs/contracts/tools (IR + emitterlar)-->
                                              clients/swift/CommanderContracts/.../Generated.swift
                                              clients/dart/commander_contracts/lib/src/generated.dart
```

```bash
npm run -w libs/contracts gen:schema   # qayta generatsiya (build + yozish)
npm run -w libs/contracts gen:check    # diskdagi natija kontraktdan chetga chiqsa exit 1 (root `npm test` ham tekshiradi)
node clients/tools/capture-fixtures.mjs  # jonli center'dan (dashboard proksisi, faqat GET) tozalangan fixture'lar
```

## Ulash

- **Swift (macOS 14+, iOS 17+)**: Xcode loyihasida *Add Package Dependency > Add Local* `clients/swift/CommanderContracts`
  (yoki `.package(path: "../../clients/swift/CommanderContracts")`), `import CommanderContracts`.
- **Dart/Flutter**: `pubspec.yaml` ga `commander_contracts: { path: ../../clients/dart/commander_contracts }`,
  `import 'package:commander_contracts/commander_contracts.dart';`.

## Qoidalar (ikkala til uchun bir xil)

- Nomlar sxema nomi (eksport nomi, `Schema`siz): `SessionDto`, `ListSessionsResponseV1`, `ServerToClientMessage`...
- Vaqtlar **ISO-8601 `String`** (REST/WS) yoki `Int` epoch ms (`*Ms`/`ts`); parse uchun `ContractDates` (Swift/Dart).
- `integer` -> `Int`/`int`, `number` -> `Double`/`double`; `unknown` -> `JSONValue` (Swift) / `Object?` (Dart).
- Enum: noma'lum (kelajakdagi) qiymat **yiqitmaydi**: Swift `.unknown(String)`, Dart `X.unknown`.
- Diskriminantli union (WS konvertlar `type`, chat elementlari `kind`, buyruq tanasi `type`): Swift `enum` (`case .sessionUpdated(...)`,
  `.unknown(type:raw:)`), Dart `sealed class` (`ServerToClientMessageSessionUpdated(:final value)`, `...Unknown(raw)`).
  Dart'da variant o'rami nomi inline variant obyekti bilan to'qnashsa `...Case` qo'shimchasi oladi.
- Const maydonlar (`v: 1`, `type: "subscribe"`) init'da parametr emas, avtomatik to'ldiriladi.
- `required + nullable` maydon `null` bilan yoziladi; ixtiyoriy maydon `nil`/`null` bo'lsa yozilmaydi.
- Konstantalar (`/ws/client` yo'li, subprotocol, close kodlari, kanallar, scope'lar): `CommanderContract.*`.
- Qo'lda yozilgan yordamchilar faqat `Helpers.swift` / `helpers.dart`: `ContractDates`, `ClientWebSocketAuth.subprotocols`, `PairingURL` (`commander://pair?c=&code=&fp=`).

## Testlar

```bash
(cd clients/swift/CommanderContracts && swift test)
(cd clients/dart/commander_contracts && dart pub get && dart test)
```
Ikkalasi `clients/fixtures/` ni dekodlaydi (jonli center'dan olingan tozalangan javoblar + WS namunalari; `manifest.json` fayl -> sxema).
`libs/contracts` Zod spec'i xuddi shu fixture'larni sxemalarga qarshi tekshiradi (fixture kontraktdan chiqib ketmasin).
