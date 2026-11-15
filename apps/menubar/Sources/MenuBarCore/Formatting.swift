import CommanderContracts
import Foundation

/// Menu-bar ikonkasi yonidagi matn formati (sozlamalarda tanlanadi).
public enum MenuTextFormat: String, CaseIterable, Sendable, Codable {
    /// "3▶ 1⏳ 2! 8%"
    case full
    /// "3▶ 1⏳ 2!"
    case counts
    /// "8%"
    case limit
    /// Faqat ikonka.
    case iconOnly

    public var title: String {
        switch self {
        case .full: return "Sessiyalar va limit"
        case .counts: return "Faqat sessiyalar"
        case .limit: return "Faqat limit"
        case .iconOnly: return "Faqat ikonka"
        }
    }
}

/// Menu-bar matnida qaysi limit oynasi ko'rsatiladi.
public enum LimitWindowChoice: String, CaseIterable, Sendable, Codable {
    case sevenDay
    case fiveHour
    /// Ikkalasidan kattasi.
    case highest

    public var title: String {
        switch self {
        case .sevenDay: return "Haftalik"
        case .fiveHour: return "5 soat"
        case .highest: return "Eng yuqorisi"
        }
    }
}

public enum LimitFormat {
    /// "8%" (rasmiy) yoki "≈8%" (taxmin; CLAUDE.md #6: taxmin rasmiydek ko'rsatilmaydi).
    public static func percent(_ w: LimitWindowView) -> String {
        let pct = Int(w.usedPct.rounded())
        return isEstimate(w) ? "≈\(pct)%" : "\(pct)%"
    }

    public static func isEstimate(_ w: LimitWindowView) -> Bool {
        w.source != .official || w.reset
    }

    /// Rang chegaralari (DESIGN-BRIEF: 80% sariq, 95% qizil).
    public enum Level: Equatable, Sendable { case normal, warn, critical }

    public static func level(_ w: LimitWindowView) -> Level {
        if w.usedPct >= 95 { return .critical }
        if w.usedPct >= 80 { return .warn }
        return .normal
    }

    /// Kartadagi izoh: "yangilandi", "3 soat oldin kuzatilgan" va h.k.
    public static func note(_ w: LimitWindowView, now: Date) -> String? {
        if w.reset { return "yangilandi" }
        if w.stale, let observed = w.observedAt.flatMap(ContractDates.parse) {
            return "\(relative(from: observed, to: now)) kuzatilgan"
        }
        if w.source != .official { return "taxmin" }
        return nil
    }

    /// "≈ 15:40 da tugaydi". Faqat oyna yangilanishidan OLDIN tugashi bashorat qilinsa (`beforeReset`).
    public static func forecast(_ w: LimitWindowView, now: Date, calendar: Calendar = .current) -> String? {
        guard let f = w.forecast, f.beforeReset, let at = ContractDates.parse(f.exhaustsAt) else { return nil }
        if at <= now { return "≈ tugagan bo'lishi mumkin" }
        return "≈ \(clock(at, now: now, calendar: calendar)) da tugaydi"
    }

    /// "15:40 da yangilanadi"
    public static func resetText(_ w: LimitWindowView, now: Date, calendar: Calendar = .current) -> String? {
        guard let r = w.resetsAt.flatMap(ContractDates.parse), r > now else { return nil }
        return "\(clock(r, now: now, calendar: calendar)) da yangilanadi"
    }

    /// Bugun: "15:40"; ertaga: "ertaga 03:00"; keyin: "16.11 03:00".
    public static func clock(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let hm = String(format: "%02d:%02d", calendar.component(.hour, from: date), calendar.component(.minute, from: date))
        if calendar.isDate(date, inSameDayAs: now) { return hm }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "ertaga \(hm)"
        }
        let d = calendar.component(.day, from: date), m = calendar.component(.month, from: date)
        return String(format: "%02d.%02d %@", d, m, hm)
    }

    /// "hozirgina", "5 daqiqa oldin", "3 soat oldin", "2 kun oldin".
    public static func relative(from date: Date, to now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(date)))
        if s < 60 { return "hozirgina" }
        if s < 3600 { return "\(s / 60) daqiqa oldin" }
        if s < 86_400 { return "\(s / 3600) soat oldin" }
        return "\(s / 86_400) kun oldin"
    }

    public static func window(_ limits: LimitsResponse?, choice: LimitWindowChoice) -> LimitWindowView? {
        guard let limits else { return nil }
        switch choice {
        case .sevenDay: return limits.sevenDay
        case .fiveHour: return limits.fiveHour
        case .highest:
            switch (limits.fiveHour, limits.sevenDay) {
            case let (a?, b?): return a.usedPct >= b.usedPct ? a : b
            case let (a?, nil): return a
            case let (nil, b?): return b
            case (nil, nil): return nil
            }
        }
    }
}

public enum MenuText {
    /// Menu-bar matni. Nol qiymatlar tashlab ketiladi; aloqa yo'qligida "⚠".
    public static func format(
        summary: DashboardSummary, limits: LimitsResponse?, connection: ConnectionStatus,
        format: MenuTextFormat, window: LimitWindowChoice = .sevenDay
    ) -> String {
        switch connection {
        case .unpaired: return ""
        case .unauthorized, .reconnecting: return "⚠"
        case .connecting, .live: break
        }
        var parts: [String] = []
        if format == .full || format == .counts {
            if summary.working > 0 { parts.append("\(summary.working)▶") }
            if summary.waiting > 0 { parts.append("\(summary.waiting)⏳") }
            if summary.approvals > 0 { parts.append("\(summary.approvals)!") }
        }
        if format == .full || format == .limit, let w = LimitFormat.window(limits, choice: window) {
            parts.append(LimitFormat.percent(w))
        }
        return parts.joined(separator: " ")
    }

    /// VoiceOver uchun to'liq jumla.
    public static func accessibilityLabel(summary: DashboardSummary, limits: LimitsResponse?, connection: ConnectionStatus) -> String {
        switch connection {
        case .unpaired: return "Commander: ulanmagan"
        case .unauthorized: return "Commander: token bekor qilingan, qayta ulash kerak"
        case .reconnecting: return "Commander: markaz bilan aloqa yo'q, qayta ulanmoqda"
        case .connecting, .live: break
        }
        var parts = ["Commander"]
        if summary.approvals > 0 { parts.append("\(summary.approvals) ta ruxsat so'rovi") }
        if summary.waiting > 0 { parts.append("\(summary.waiting) ta javob kutmoqda") }
        if summary.working > 0 { parts.append("\(summary.working) ta ishlamoqda") }
        if summary.approvals == 0 && summary.waiting == 0 && summary.working == 0 { parts.append("hammasi tinch") }
        if let w = limits?.sevenDay {
            parts.append("haftalik limit \(LimitFormat.isEstimate(w) ? "taxminan " : "")\(Int(w.usedPct.rounded())) foiz")
        }
        return parts.joined(separator: ", ")
    }
}

public enum StatusText {
    public static func label(_ s: SessionStatus) -> String {
        switch s {
        case .working: return "ishlamoqda"
        case .waiting: return "kutmoqda"
        case .awaitingApproval: return "ruxsat"
        case .idle: return "bo'sh"
        case .done: return "tugatdi"
        case .ended: return "yopilgan"
        case .unknown(let raw): return raw
        }
    }

    /// Ko'rsatish tartibi (diqqat talab qiladiganlari oldin).
    public static func order(_ s: SessionStatus) -> Int {
        switch s {
        case .awaitingApproval: return 0
        case .waiting: return 1
        case .working: return 2
        case .done: return 3
        case .idle: return 4
        default: return 5
        }
    }

    public static func health(_ s: HealthStatus) -> String {
        switch s {
        case .ok: return "joyida"
        case .warn: return "ogohlantirish"
        case .critical: return "jiddiy"
        case .offline: return "oflayn"
        case .unknownValue, .unknown: return "noma'lum"
        }
    }
}

/// Loyiha bo'yicha guruhlash (panel: "Loyihalar bo'yicha").
public struct ProjectGroup: Equatable, Sendable, Identifiable {
    public var id: String { name }
    public let name: String
    /// Holat -> soni, ko'rsatish tartibida.
    public let counts: [StatusCount]
    public let sessions: [SessionDto]

    public struct StatusCount: Equatable, Sendable, Hashable {
        public let status: SessionStatus
        public let count: Int
    }

    /// Diqqat talab qiladigan loyihalar tepada, keyin nom bo'yicha.
    public static func group(_ sessions: [SessionDto]) -> [ProjectGroup] {
        let byProject = Dictionary(grouping: sessions, by: \.projectName)
        let groups = byProject.map { name, list -> ProjectGroup in
            let byStatus = Dictionary(grouping: list, by: \.status)
            let counts = byStatus.map { StatusCount(status: $0.key, count: $0.value.count) }
                .sorted { StatusText.order($0.status) < StatusText.order($1.status) }
            let sorted = list.sorted { (StatusText.order($0.status), $0.statusSince) < (StatusText.order($1.status), $1.statusSince) }
            return ProjectGroup(name: name, counts: counts, sessions: sorted)
        }
        return groups.sorted {
            let a = $0.counts.first.map { StatusText.order($0.status) } ?? 9
            let b = $1.counts.first.map { StatusText.order($0.status) } ?? 9
            return a != b ? a < b : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }
}

public enum ApprovalText {
    /// "Bash: docker compose …" — panel va bildirishnoma uchun bitta qatorli, qisqartirilgan ko'rinish.
    /// Matn markazda allaqachon redakt qilingan; biz faqat qisqartiramiz (CLAUDE.md #5: to'liq kiritma yuborilmaydi).
    public static func summary(_ a: ApprovalDto, max: Int = 160) -> String {
        if a.kind == .plan { return "Reja: \(truncate(firstLine(a.plan ?? ""), max: max))" }
        let input = a.toolInputRedacted.replacingOccurrences(of: "\n", with: " ")
        return truncate("\(a.toolName): \(input)", max: max)
    }

    public static func project(_ a: ApprovalDto) -> String {
        a.projectName ?? URL(fileURLWithPath: a.cwd).lastPathComponent
    }

    /// Deadline'gacha qolgan vaqt "4:12".
    public static func remaining(_ a: ApprovalDto, now: Date) -> String? {
        guard let d = ContractDates.parse(a.deadline) else { return nil }
        let s = Int(d.timeIntervalSince(now))
        if s <= 0 { return "0:00" }
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    public static func remainingSeconds(_ a: ApprovalDto, now: Date) -> Int? {
        ContractDates.parse(a.deadline).map { Int($0.timeIntervalSince(now)) }
    }

    public static func truncate(_ s: String, max: Int) -> String {
        s.count <= max ? s : String(s.prefix(max - 1)) + "…"
    }

    private static func firstLine(_ s: String) -> String {
        s.split(whereSeparator: \.isNewline).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
    }
}
