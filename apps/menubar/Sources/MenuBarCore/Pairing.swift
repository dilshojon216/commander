import CommanderContracts
import Foundation

/// "Ulash" oynasi kiritmasi -> center URL + kod. `commander://pair?...` havolasi yoki qo'lda kiritish.
public struct PairingRequest: Equatable, Sendable {
    public let centerURL: URL
    public let code: String
    public let fingerprint: String?

    public init(centerURL: URL, code: String, fingerprint: String? = nil) {
        self.centerURL = centerURL
        self.code = code
        self.fingerprint = fingerprint
    }

    public enum ParseError: Error, Equatable, Sendable {
        case invalidLink
        case invalidCenterURL
        case invalidCode

        public var message: String {
            switch self {
            case .invalidLink: return "Havola noto'g'ri: commander://pair?c=…&code=… ko'rinishida bo'lishi kerak"
            case .invalidCenterURL: return "Center manzili https:// bilan boshlanishi kerak (yoki http://127.0.0.1)"
            case .invalidCode: return "Kod noto'g'ri: XXXXX-XXXXX (10 belgi)"
            }
        }
    }

    /// `commander://pair?c=&code=&fp=` (generatsiya qilingan `PairingURL.parse` orqali).
    public static func fromLink(_ raw: String) -> Result<PairingRequest, ParseError> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let p = PairingURL.parse(trimmed) else { return .failure(.invalidLink) }
        guard let code = normalizeCode(p.code) else { return .failure(.invalidCode) }
        return .success(PairingRequest(centerURL: p.centerURL, code: code, fingerprint: p.fingerprint))
    }

    /// Qo'lda: center URL + kod.
    public static func manual(center: String, code: String) -> Result<PairingRequest, ParseError> {
        guard let url = validCenterURL(center) else { return .failure(.invalidCenterURL) }
        guard let c = normalizeCode(code) else { return .failure(.invalidCode) }
        return .success(PairingRequest(centerURL: url, code: c))
    }

    /// Kiritilgan matn havola bo'lsa havola sifatida, aks holda qo'lda maydonlar.
    public static func parse(link: String, center: String, code: String) -> Result<PairingRequest, ParseError> {
        let l = link.trimmingCharacters(in: .whitespacesAndNewlines)
        if !l.isEmpty { return fromLink(l) }
        return manual(center: center, code: code)
    }

    /// Crockford: katta harf, bo'shliq olib tashlanadi, `XXXXX-XXXXX` ko'rinishiga keltiriladi.
    /// Kontrakt sxemasi (`EnrollmentCodeSchema`): 8..24 belgi, `[0-9A-Za-z -]`.
    public static func normalizeCode(_ raw: String) -> String? {
        let compact = raw.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        guard compact.count >= 8, compact.count <= 24, compact.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else {
            return nil
        }
        if compact.count == CommanderContract.clientPairingCodeLength {
            return "\(compact.prefix(5))-\(compact.suffix(5))"
        }
        return compact
    }

    /// https (tailnet) yoki dev uchun http://127.0.0.1 / localhost. Yo'l/so'rov qismlari olib tashlanadi.
    public static func validCenterURL(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard var c = URLComponents(string: s), let host = c.host, !host.isEmpty else { return nil }
        let loopback = c.scheme == "http" && (host == "127.0.0.1" || host == "localhost")
        guard c.scheme == "https" || loopback else { return nil }
        c.query = nil
        c.fragment = nil
        if c.path == "/" { c.path = "" }
        return c.url
    }

    /// `POST /v1/clients/pair` tanasi (platform `macos`).
    public func body(deviceName: String) -> ClientPairBody {
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        return ClientPairBody(code: code, deviceName: String((name.isEmpty ? "Mac" : name).prefix(100)), platform: "macos")
    }
}

/// `POST /v1/clients/pair` xatolari (PLAN "klient pairing": hamma kod xatosi bir xil 401).
public enum PairingFailure: Error, Equatable, Sendable {
    case invalidCode
    case rateLimited
    case lockdown
    case badRequest(String)
    case network(String)
    case server(Int)

    public var message: String {
        switch self {
        case .invalidCode: return "Kod noto'g'ri, ishlatilgan yoki muddati o'tgan. Yangi kod yarating."
        case .rateLimited: return "Juda ko'p urinish. 10 daqiqadan keyin qayta urinib ko'ring."
        case .lockdown: return "Lockdown yoqiq: hozir ulab bo'lmaydi."
        case .badRequest(let m): return "So'rov rad etildi: \(m)"
        case .network(let m): return "Markazga ulanib bo'lmadi: \(m)"
        case .server(let s): return "Server xatosi (\(s))"
        }
    }

    public static func from(status: Int, body: Data) -> PairingFailure {
        let err = try? JSONDecoder().decode(ApiError.self, from: body)
        switch status {
        case 401: return .invalidCode
        case 429: return .rateLimited
        case 403 where err?.error == "lockdown": return .lockdown
        case 400: return .badRequest(err?.message ?? "noto'g'ri ma'lumot")
        default: return .server(status)
        }
    }
}
