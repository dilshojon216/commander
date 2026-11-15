import Foundation

/// Xavfli amallar uchun "yangi tasdiq" (elevation) talabi. Qoidalar web `elevationFor` bilan aynan bir xil:
/// regex'lar generatsiya qilinadi (`scripts/gen-elevation-rules.mjs`), natija web'ning haqiqiy javoblari bilan testda solishtiriladi.
public enum Elevation: String, Sendable, Equatable {
    /// Faqat o'qish yoki xavfni kamaytiradigan amal (bekor qilish, rad etish, to'xtatish...).
    case none
    /// Har doim kerak.
    case required
    /// Ruxsat qarori: `deny` tasdiqsiz, `allow` tasdiq bilan (tanaga qarab).
    case decision
    /// `POST /commands`: `session.stop` tasdiqsiz, qolgan buyruqlar (start, prompt, set_mode...) tasdiq bilan.
    case command
}

/// FAIL-CLOSED: o'zgartiruvchi har qanday yo'l, ochiq istisno ro'yxatida bo'lmasa, tasdiq talab qiladi.
public enum ElevationPolicy {
    private static let decisionRule = compile(GeneratedElevationRules.decision)
    private static let queueItemRule = compile(GeneratedElevationRules.queueItem)
    private static let templateItemRule = compile(GeneratedElevationRules.templateItem)
    private static let exemptRules = GeneratedElevationRules.exempt.map(compile)

    public static func elevation(method: HTTPMethod, segments: [String]) -> Elevation {
        if method == .get { return .none }
        let path = segments.joined(separator: "/")
        if matches(decisionRule, path) { return .decision }
        if path == "commands" && method == .post { return .command }
        // Navbat elementi: olib tashlash tasdiqsiz, tahrirlash (prompt o'zgartirish) tasdiq bilan.
        if matches(queueItemRule, path) { return method == .delete ? .none : .required }
        // Saqlangan shablonni tahrirlash/o'chirish hech narsani ishga tushirmaydi (yuborish `send-prompt` da tasdiq talab qiladi).
        if matches(templateItemRule, path) { return .none }
        if exemptRules.contains(where: { matches($0, path) }) { return .none }
        return .required
    }

    /// Tana bo'yicha aniqlashtirish: `decision` — `behavior != deny`, `command` — `type != session.stop`. Tana o'qilmasa tasdiq talab qilinadi.
    public static func isRequired(_ elevation: Elevation, body: Data?) -> Bool {
        switch elevation {
        case .none: return false
        case .required: return true
        case .decision: return field("behavior", in: body) != "deny"
        case .command: return field("type", in: body) != "session.stop"
        }
    }

    /// Endpoint uchun tasdiq kerakmi (tana kodlanmasa — kerak).
    public static func isRequired<Response>(for endpoint: Endpoint<Response>) -> Bool {
        let level = elevation(method: endpoint.method, segments: endpoint.segments)
        guard level == .decision || level == .command else { return isRequired(level, body: nil) }
        return isRequired(level, body: try? endpoint.bodyData())
    }

    // MARK: ichki

    /// Kompilyatsiya bo'lmasa `nil`: istisno qoidasi mos kelmaydi => tasdiq TALAB qilinadi (fail-closed). Test hammasi kompilyatsiya bo'lishini tekshiradi.
    private static func compile(_ pattern: String) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern)
    }

    private static func matches(_ rule: NSRegularExpression?, _ path: String) -> Bool {
        guard let rule else { return false }
        return rule.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil
    }

    private static func field(_ name: String, in body: Data?) -> String? {
        guard let body, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        return object[name] as? String
    }

    /// Testlar uchun: barcha generatsiya qilingan regex'lar kompilyatsiya bo'ldimi.
    static var allRulesCompiled: Bool {
        decisionRule != nil && queueItemRule != nil && templateItemRule != nil && exemptRules.allSatisfy { $0 != nil }
    }
}
