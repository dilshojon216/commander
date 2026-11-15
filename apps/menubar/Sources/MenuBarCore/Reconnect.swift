import CommanderContracts
import Foundation

/// Eksponensial backoff + jitter. Sof: tasodif manbai tashqaridan beriladi (testlar uchun).
public struct ReconnectPolicy: Sendable, Equatable {
    public var base: TimeInterval
    public var factor: Double
    public var maxDelay: TimeInterval
    /// ±ulush (0.2 = ±20%).
    public var jitter: Double

    public init(base: TimeInterval = 1, factor: Double = 2, maxDelay: TimeInterval = 60, jitter: Double = 0.2) {
        self.base = base
        self.factor = factor
        self.maxDelay = maxDelay
        self.jitter = jitter
    }

    /// `attempt` 1 dan boshlanadi. `random` [0, 1) qiymat.
    public func delay(attempt: Int, random: Double) -> TimeInterval {
        let n = max(1, attempt)
        let raw = min(maxDelay, base * pow(factor, Double(n - 1)))
        let j = 1 + jitter * (2 * min(max(random, 0), 1) - 1)
        return min(maxDelay, max(0.5, raw * j))
    }
}

/// WS yopilish kodi -> nima qilish kerak (PLAN §8 close kodlari).
public enum CloseDecision: Equatable, Sendable {
    /// Backoff bilan qayta ulanish.
    case reconnect
    /// Darhol (backoff'siz) qayta ulanish: server o'chyapti (1001).
    case reconnectNow
    /// Qayta ulanmaslik: token rad etildi / revoke. Qayta pairing kerak.
    case stop(reason: String)
    /// Protokol xatosi (4003): bug, qayta ulanish tuzatmaydi — lekin ilova "o'lik" qolmasin: uzun kutish.
    case reconnectSlow

    public static func from(code: Int?) -> CloseDecision {
        switch code {
        case CommanderContract.clientWsCloseGoingAway?:
            return .reconnectNow
        case CommanderContract.clientWsCloseAuthFailed?:
            return .stop(reason: "Token rad etildi (4001): qayta ulang")
        case CommanderContract.clientWsCloseRevoked?:
            return .stop(reason: "Token bekor qilingan yoki muddati o'tgan (4010): qayta ulang")
        case CommanderContract.clientWsCloseProtocolError?:
            return .reconnectSlow
        default:
            // 4002 (auth timeout), 4008 (tezlik), 1013 (sekin klient), 1006 (tarmoq) va h.k.
            return .reconnect
        }
    }
}

/// Ulanish urinishlari hisoblagichi: muvaffaqiyatli `auth.ok` dan keyin nolga tushadi.
public struct ReconnectState: Sendable, Equatable {
    public private(set) var attempt = 0
    public let policy: ReconnectPolicy
    public static let slowDelay: TimeInterval = 5 * 60

    public init(policy: ReconnectPolicy = ReconnectPolicy()) { self.policy = policy }

    public mutating func connected() { attempt = 0 }

    /// Keyingi urinishgacha kutish (nil = qayta ulanmaslik).
    public mutating func next(after decision: CloseDecision, random: Double) -> TimeInterval? {
        switch decision {
        case .stop: return nil
        case .reconnectNow:
            attempt = 0
            return 0.5
        case .reconnectSlow:
            attempt += 1
            return Self.slowDelay
        case .reconnect:
            attempt += 1
            return policy.delay(attempt: attempt, random: random)
        }
    }
}

/// center URL -> `/ws/client` WebSocket URL (https -> wss, http(loopback) -> ws).
public enum CenterURLs {
    public static func webSocket(center: URL) -> URL? {
        guard var c = URLComponents(url: center, resolvingAgainstBaseURL: false) else { return nil }
        switch c.scheme {
        case "https": c.scheme = "wss"
        case "http": c.scheme = "ws"
        default: return nil
        }
        c.path = CommanderContract.clientWsPath
        c.query = nil
        c.fragment = nil
        return c.url
    }

    public static func api(center: URL, path: String, query: [URLQueryItem] = []) -> URL? {
        guard var c = URLComponents(url: center, resolvingAgainstBaseURL: false) else { return nil }
        let basePath = c.path.hasSuffix("/") ? String(c.path.dropLast()) : c.path
        c.path = basePath + path
        c.queryItems = query.isEmpty ? nil : query
        return c.url
    }
}
