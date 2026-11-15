import CommanderContracts
import Foundation

/// Dashboard oynasidagi sahifa (mavjud Next.js marshrutlari). Bildirishnoma/maskot shu orqali chuqur havola beradi.
/// Id'lar tekshiriladi (path injection yo'q): faqat `[A-Za-z0-9_-]`, <= 128 belgi.
public enum DashboardTarget: Equatable, Sendable {
    /// `/` — umumiy ko'rinish (ruxsat so'rovlari ham shu yerda).
    case overview
    case session(String)
    case project(String)
    case projectWork(String)
    case machine(String)
    case alerts
    case usage
    case queue

    public var path: String {
        switch self {
        case .overview: "/"
        case .session(let id): "/sessions/\(id)"
        case .project(let id): "/projects/\(id)"
        case .projectWork(let id): "/projects/\(id)/work"
        case .machine(let id): "/machines/\(id)"
        case .alerts: "/alerts"
        case .usage: "/usage"
        case .queue: "/queue"
        }
    }

    static func validID(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 128 && s.unicodeScalars.allSatisfy { c in
            (c.value >= 0x30 && c.value <= 0x39) || (c.value >= 0x41 && c.value <= 0x5A) || (c.value >= 0x61 && c.value <= 0x7A) || c == "-" || c == "_"
        }
    }

    /// Yo'lni (bildirishnoma `userInfo`dan) xavfsiz qayta tiklaydi; noma'lum/yaroqsiz yo'l -> nil.
    public init?(path: String) {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.first == "" else { return nil }
        let p = Array(parts.dropFirst())
        switch p.count {
        case 1:
            switch p[0] {
            case "": self = .overview
            case "alerts": self = .alerts
            case "usage": self = .usage
            case "queue": self = .queue
            default: return nil
            }
        case 2:
            guard Self.validID(p[1]) else { return nil }
            switch p[0] {
            case "sessions": self = .session(p[1])
            case "projects": self = .project(p[1])
            case "machines": self = .machine(p[1])
            default: return nil
            }
        case 3:
            guard p[0] == "projects", p[2] == "work", Self.validID(p[1]) else { return nil }
            self = .projectWork(p[1])
        default:
            return nil
        }
    }

    /// Faqat yaroqli id'lar bilan yaratish (aks holda umumiy ko'rinish).
    public static func session(orOverview id: String?) -> DashboardTarget {
        guard let id, validID(id) else { return .overview }
        return .session(id)
    }

    public func url(base: URL) -> URL? {
        guard var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        c.path = path
        c.query = nil
        c.fragment = nil
        return c.url
    }

    /// Hodisa -> dashboard sahifasi (bildirishnoma bosilishi va maskot "Ko'rish/Ochish").
    public static func forEvent(_ event: DashboardEvent) -> DashboardTarget? {
        switch event {
        case .approvalRequested(let a), .approvalResolved(let a):
            // Sessiya sahifasida ham ruxsat kartasi bor; sessiyasiz so'rov umumiy ko'rinishda.
            return session(orOverview: a.sessionId)
        case .sessionWaiting(let s), .sessionDone(let s):
            return session(orOverview: s.id)
        case .healthDegraded(let machineId, _, _):
            return validID(machineId) ? .machine(machineId) : .overview
        case .alertOpened(let a):
            return validID(a.sessionId) ? .session(a.sessionId) : .alerts
        case .lockdownChanged:
            return nil
        }
    }
}

/// Dashboard sozlamasi: faqat `http(s)://host[:port]` (yo'l, so'rov, login qismi tashlanadi).
public enum DashboardBaseURL {
    public static let `default` = URL(string: "http://127.0.0.1:4318")!

    public static func parse(_ raw: String) -> URL? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = c.host, !host.isEmpty, c.user == nil, c.password == nil else { return nil }
        var out = URLComponents()
        out.scheme = scheme
        out.host = host
        out.port = c.port
        return out.url
    }
}

/// WKWebView navigatsiya siyosati: faqat sozlangan dashboard origin'i (127.0.0.1 <-> localhost tengdosh) ichkarida;
/// boshqa http(s)/mailto havolalar tizim brauzerida; qolgan sxemalar (file:, javascript:, data:, commander:) bloklanadi.
public enum DashboardNavigationPolicy {
    public enum Decision: Equatable, Sendable { case allow, openExternally, cancel }

    static let loopback: Set<String> = ["127.0.0.1", "localhost", "::1", "[::1]"]

    static func effectivePort(_ u: URL) -> Int? {
        if let p = u.port { return p }
        switch u.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }

    public static func isInternal(_ url: URL, base: URL) -> Bool {
        guard let s = url.scheme?.lowercased(), s == base.scheme?.lowercased(),
              let h = url.host?.lowercased(), let bh = base.host?.lowercased(),
              effectivePort(url) == effectivePort(base) else { return false }
        if h == bh { return true }
        return loopback.contains(h) && loopback.contains(bh)
    }

    public static func decide(_ url: URL?, base: URL, isMainFrame: Bool) -> Decision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        switch scheme {
        case "about":
            return ["about:blank", "about:srcdoc"].contains(url.absoluteString.lowercased()) ? .allow : .cancel
        case "blob":
            // blob:http://127.0.0.1:4318/<uuid> — faqat o'z origin'imizniki.
            let inner = String(url.absoluteString.dropFirst("blob:".count))
            guard let u = URL(string: inner) else { return .cancel }
            return isInternal(u, base: base) ? .allow : .cancel
        case "http", "https":
            if isInternal(url, base: base) { return .allow }
            // iframe'dagi begona manzil brauzerni o'z-o'zidan ochmasin.
            return isMainFrame ? .openExternally : .cancel
        case "mailto":
            return isMainFrame ? .openExternally : .cancel
        default:
            return .cancel
        }
    }
}

/// Dock ikonkasi: dashboard oynasi ochiq bo'lsa `.regular`, yopilsa `.accessory` (faqat menu-bar).
public struct ActivationPolicyState: Equatable, Sendable {
    public enum Policy: Equatable, Sendable { case regular, accessory }
    public private(set) var openWindows = 0

    public init() {}

    public var policy: Policy { openWindows > 0 ? .regular : .accessory }

    /// Qaytish: siyosat o'zgargan bo'lsa yangi qiymat (o'zgarmasa nil — keraksiz `setActivationPolicy` yo'q).
    public mutating func windowOpened() -> Policy? {
        let before = policy
        openWindows += 1
        return policy == before ? nil : policy
    }

    public mutating func windowClosed() -> Policy? {
        let before = policy
        openWindows = max(0, openWindows - 1)
        return policy == before ? nil : policy
    }
}
