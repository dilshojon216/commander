import Foundation

/// Kontraktda vaqtlar ISO-8601 SATR sifatida (REST/WS DTO'lar: `2026-11-14T04:00:28.445Z`), agent kanalida epoch ms.
/// Generator modellarida ular `String` bo'lib qoladi (dekodlashda xato chiqarmaslik uchun); kerak bo'lganda shu yerdan parse qiling.
public enum ContractDates {
    // ISO8601FormatStyle (Sendable) ISO8601DateFormatter'ga qaraganda Swift 6 uchun qulay.
    public static func parse(_ iso: String) -> Date? {
        if let d = try? Date(iso, strategy: .iso8601.year().month().day().dateSeparator(.dash).time(includingFractionalSeconds: true).timeSeparator(.colon).timeZone(separator: .omitted)) { return d }
        return try? Date(iso, strategy: .iso8601)
    }

    public static func format(_ date: Date) -> String {
        date.formatted(.iso8601.year().month().day().dateSeparator(.dash).time(includingFractionalSeconds: true).timeSeparator(.colon).timeZone(separator: .omitted))
    }

    /// Epoch millisekund (`EpochMs`) -> Date.
    public static func fromEpochMs(_ ms: Int) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }
}

/// `/ws/client` autentifikatsiyasi: token `Sec-WebSocket-Protocol` orqali (query string'da HECH QACHON).
public enum ClientWebSocketAuth {
    /// Qiymatlar `Sec-WebSocket-Protocol` sarlavhasiga (vergul bilan) yoki `URLSessionWebSocketTask` protocols'ga beriladi.
    public static func subprotocols(token: String) -> [String] {
        [CommanderContract.clientWsSubprotocol, "\(CommanderContract.clientWsTokenSubprotocolPrefix)\(token)"]
    }
}

/// QR / deep-link: `commander://pair?c=<center https url>&code=<code>[&fp=<fingerprint>]`.
public struct PairingURL: Hashable, Sendable {
    public let centerURL: URL
    public let code: String
    public let fingerprint: String?

    public init(centerURL: URL, code: String, fingerprint: String? = nil) {
        self.centerURL = centerURL
        self.code = code
        self.fingerprint = fingerprint
    }

    /// Noto'g'ri URL uchun nil. Center manzili `https` (yoki dev uchun `http://127.0.0.1` / `localhost`).
    public static func parse(_ raw: String) -> PairingURL? {
        guard let comps = URLComponents(string: raw),
              comps.scheme == "commander", comps.host == "pair" else { return nil }
        let items = comps.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard let c = value("c"), let code = value("code"), !code.isEmpty,
              let center = URL(string: c), let host = center.host else { return nil }
        let loopback = center.scheme == "http" && (host == "127.0.0.1" || host == "localhost")
        guard center.scheme == "https" || loopback else { return nil }
        return PairingURL(centerURL: center, code: code, fingerprint: value("fp"))
    }
}
