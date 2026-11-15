import Foundation

/// Token ruxsatlari va lockdown holati bo'yicha: so'rovni yuborishdan OLDIN foydalanuvchiga aniq sabab ko'rsatish uchun.
/// Haqiqiy ruxsatni markaz tekshiradi (guard); bu faqat qulay old-tekshiruv, xavfsizlik chegarasi emas.
public struct ScopePolicy: Equatable, Sendable {
    public enum Verdict: Equatable, Sendable {
        case allowed
        case missingScope(RequiredScope)
        /// Lockdown: o'zgartiruvchi so'rov bloklangan (markaz 403 `lockdown` qaytaradi).
        case lockdown
    }

    /// Token ruxsatlari (`read`, `approve`, `control`, `admin`).
    public let scopes: Set<String>
    public let lockdown: Bool

    public init(scopes: Set<String>, lockdown: Bool = false) {
        self.scopes = scopes
        self.lockdown = lockdown
    }

    public func allows(_ scope: RequiredScope) -> Bool {
        scopes.contains(scope.rawValue)
    }

    public var canControl: Bool { allows(.control) }
    public var canApprove: Bool { allows(.approve) }

    public func verdict<Response>(for endpoint: Endpoint<Response>) -> Verdict {
        guard allows(endpoint.scope) else { return .missingScope(endpoint.scope) }
        if lockdown, endpoint.method != .get, !Self.isLockdownExempt(endpoint.method, endpoint.segments) { return .lockdown }
        return .allowed
    }

    /// Markazda `@LockdownExempt` bo'lgan yozuvlar (xavfni kamaytiradi yoki masofaviy amal emas): qaror, bekor qilish, unpair...
    /// Qaror (`decision`) lockdown'da faqat `deny` — buni markaz tana bo'yicha hal qiladi. `nil` = istalgan segment.
    private static let lockdownExempt: [(method: HTTPMethod, pattern: [String?])] = [
        (.post, ["devices", "me", "revoke"]),
        (.post, ["approvals", nil, "decision"]),
        (.post, ["alerts", nil, "dismiss"]),
        (.post, ["orchestrations", nil, "cancel"]),
        (.post, ["projects", nil, "archive"]),
        (.post, ["projects", nil, "unarchive"]),
        (.delete, ["approval-rules", nil]),
        (.put, ["settings", "stepup-exemption"]),
    ]

    static func isLockdownExempt(_ method: HTTPMethod, _ segments: [String]) -> Bool {
        lockdownExempt.contains { rule in
            rule.method == method && rule.pattern.count == segments.count
                && zip(rule.pattern, segments).allSatisfy { expected, actual in expected == nil || expected == actual }
        }
    }
}
