import CommanderContracts
import Foundation

/// `POST /v1/approvals/:id/decision` natijasining UI ma'nosi (PLAN "Qarorlar 1.5-1.7", 2.14).
public enum DecisionOutcome: Equatable, Sendable {
    /// 200: qabul qilindi (yoki shu qurilmaning aynan shu qarori takrori).
    case accepted(ApprovalDto, delivered: Bool)
    /// 403 `lockdown`: masofaviy `allow` rad etildi, approval pending qoladi.
    case lockdown
    /// 409 `approval_conflict`: boshqa joyda (terminal, boshqa qurilma) hal qilingan.
    case alreadyResolved(status: String?)
    /// 409 `approval_expired`.
    case expired
    /// 422 `plan_approve_unsupported`: rejani masofadan tasdiqlab bo'lmaydi.
    case planApproveUnsupported
    /// 403 `insufficient_scope`: tokenda `approve` yo'q.
    case noScope
    /// 401: token yaroqsiz/revoke.
    case unauthorized
    case notFound
    case failed(String)

    /// Karta ko'rsatadigan xabar (o'zbekcha).
    public var message: String? {
        switch self {
        case .accepted(_, let delivered):
            return delivered ? nil : "Qabul qilindi; mashina oflayn, ulanganda yetkaziladi"
        case .lockdown: return "Lockdown: faqat rad etish mumkin"
        case .alreadyResolved: return "Allaqachon hal qilingan (terminalda javob berildi)"
        case .expired: return "Muddati o'tdi: terminalda javob bering"
        case .planApproveUnsupported: return "Rejani masofadan tasdiqlab bo'lmaydi: terminalda tasdiqlang yoki fikr bilan rad eting"
        case .noScope: return "Bu qurilmada ruxsat berish huquqi (approve) yo'q"
        case .unauthorized: return "Token yaroqsiz: qayta ulang"
        case .notFound: return "So'rov topilmadi"
        case .failed(let m): return m
        }
    }

    /// Kartani ro'yxatdan olib tashlash kerakmi (so'rov endi pending emas).
    public var removesCard: Bool {
        switch self {
        case .accepted, .alreadyResolved, .expired, .notFound: return true
        default: return false
        }
    }

    /// HTTP status + javob tanasi -> natija. `ApiError.error` kodi bo'yicha.
    public static func from(status: Int, body: Data) -> DecisionOutcome {
        let dec = JSONDecoder()
        if (200..<300).contains(status) {
            guard let r = try? dec.decode(ApprovalDecisionResponse.self, from: body) else {
                return .failed("Javobni o'qib bo'lmadi")
            }
            return .accepted(r.approval, delivered: r.delivered)
        }
        let err = try? dec.decode(ApiError.self, from: body)
        let code = err?.error ?? ""
        switch (status, code) {
        case (401, _): return .unauthorized
        case (403, "lockdown"): return .lockdown
        case (403, "insufficient_scope"): return .noScope
        case (404, _): return .notFound
        case (409, "approval_expired"): return .expired
        case (409, _):
            let st = (try? dec.decode(ConflictBody.self, from: body))?.status
            return st == "expired" ? .expired : .alreadyResolved(status: st)
        case (422, "plan_approve_unsupported"): return .planApproveUnsupported
        case (429, _): return .failed("Juda ko'p so'rov: birozdan keyin urinib ko'ring")
        default: return .failed("Xato \(status)\(code.isEmpty ? "" : ": \(code)")")
        }
    }

    private struct ConflictBody: Decodable { let status: String? }
}

/// Approval kartasining lokal holati (panelda).
public enum ApprovalCardPhase: Equatable, Sendable {
    case idle
    /// "Ruxsat…" bosildi: inline tasdiq ("Ha, ruxsat berish" / "Bekor").
    case confirmingAllow
    /// "Fikr bilan rad": matn maydoni ochiq.
    case composingFeedback(String)
    case submitting(ApprovalBehavior)
    case error(String)
}

/// Qaysi tugmalar ko'rinadi (scope, lockdown, approval turi bo'yicha).
public struct ApprovalActions: Equatable, Sendable {
    /// "Ruxsat…" ko'rinadimi (scope `approve` + `tool` turi).
    public var showAllow: Bool
    /// Ko'rinadi, lekin o'chiq (lockdown).
    public var allowDisabledReason: String?
    public var showDeny: Bool
    /// Reja: "Fikr bilan rad".
    public var showDenyWithFeedback: Bool
    /// `approve` scope yo'q: faqat ko'rish.
    public var readOnlyReason: String?

    public static func compute(_ a: ApprovalDto, canApprove: Bool, lockdown: Bool) -> ApprovalActions {
        guard canApprove else {
            return ApprovalActions(showAllow: false, allowDisabledReason: nil, showDeny: false, showDenyWithFeedback: false,
                                   readOnlyReason: "Faqat ko'rish: bu qurilmada approve huquqi yo'q")
        }
        let isPlan = a.kind == .plan
        // `question`: oddiy "Ruxsat" markazda 422 bilan rad etiladi; javob variant tugmalari orqali (QuestionFlow).
        let isQuestion = a.kind == .question
        return ApprovalActions(
            showAllow: !isPlan && !isQuestion,
            allowDisabledReason: lockdown ? "Lockdown: faqat rad etish mumkin" : nil,
            showDeny: true,
            showDenyWithFeedback: isPlan,
            readOnlyReason: nil
        )
    }
}

/// Decision yuborish porti (REST klient yoki test soxtasi).
public protocol ApprovalDecider: Sendable {
    func decide(approvalId: String, body: ApprovalDecisionBody) async -> DecisionOutcome
}

/// Kartalar holati + qaror oqimi. UI'dan mustaqil (testlanadi); `@MainActor` modeli ichida ishlatiladi.
public struct ApprovalFlow: Sendable {
    public private(set) var phases: [String: ApprovalCardPhase] = [:]
    public static let maxMessageLength = 1000

    public init() {}

    public func phase(_ id: String) -> ApprovalCardPhase { phases[id] ?? .idle }

    public mutating func tapAllow(_ id: String) { phases[id] = .confirmingAllow }
    public mutating func cancel(_ id: String) { phases[id] = .idle }
    public mutating func startFeedback(_ id: String) { phases[id] = .composingFeedback("") }
    public mutating func editFeedback(_ id: String, _ text: String) { phases[id] = .composingFeedback(text) }
    public mutating func forget(_ id: String) { phases.removeValue(forKey: id) }

    /// Yuborishdan oldingi tekshiruv. `nil` = yuborish mumkin emas (masalan tasdiqsiz allow).
    public mutating func begin(_ id: String, behavior: ApprovalBehavior, message: String?, actions: ApprovalActions,
                               requireConfirm: Bool = true) -> ApprovalDecisionBody? {
        if case .submitting = phase(id) { return nil }
        switch behavior {
        case .allow:
            guard actions.showAllow else { return nil }
            if let reason = actions.allowDisabledReason { phases[id] = .error(reason); return nil }
            if requireConfirm, phase(id) != .confirmingAllow { phases[id] = .confirmingAllow; return nil }
        case .deny:
            guard actions.showDeny else { return nil }
        case .unknown:
            return nil
        }
        phases[id] = .submitting(behavior)
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        let msg = (trimmed?.isEmpty ?? true) ? nil : String(trimmed!.prefix(Self.maxMessageLength))
        return ApprovalDecisionBody(behavior: behavior, message: msg)
    }

    /// Savolga javob (variant tugmasi): lockdown/scope tekshiruvi allow bilan bir xil; tasdiqsiz (variant tanlash o'zi qaror).
    public mutating func beginAnswer(_ id: String, approval: ApprovalDto, optionIndex: Int, canApprove: Bool, lockdown: Bool) -> ApprovalDecisionBody? {
        if case .submitting = phase(id) { return nil }
        guard canApprove, let body = QuestionFlow.answerBody(for: approval, optionIndex: optionIndex) else { return nil }
        if lockdown { phases[id] = .error("Lockdown: faqat rad etish mumkin"); return nil }
        phases[id] = .submitting(.allow)
        return body
    }

    public mutating func finish(_ id: String, outcome: DecisionOutcome) {
        if outcome.removesCard, outcome.message == nil {
            phases.removeValue(forKey: id)
        } else if let m = outcome.message {
            phases[id] = .error(m)
        } else {
            phases[id] = .idle
        }
    }
}
