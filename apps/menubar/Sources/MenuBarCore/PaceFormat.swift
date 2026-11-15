import CommanderContracts
import Foundation

/// Haftalik limit tezligi (6.12) ko'rsatish mantig'i (sof). CLAUDE.md #6: taxmin ("estimate") rasmiydek ko'rsatilmaydi:
/// "≈" prefiksi va "taxmin" izohi. Raqamlarda o'nli vergul (o'zbekcha).
public enum PaceFormat {
    public static func isEstimate(_ p: WeeklyPace) -> Bool { p.source != .official }

    /// "9,8" (bitta o'nli xona, vergul).
    public static func comma1(_ v: Double) -> String {
        String(format: "%.1f", (v * 10).rounded() / 10).replacingOccurrences(of: ".", with: ",")
    }

    /// "9,8% / 18,0% (54%)"; taxmin bo'lsa "≈9,8% / ≈18,0% (54%)".
    public static func share(_ p: WeeklyPace) -> String {
        let a = isEstimate(p) ? "≈" : ""
        return "\(a)\(comma1(p.usedTodayPct))% / \(a)\(comma1(p.allowancePct))% (\(Int(p.pctOfAllowance.rounded()))%)"
    }

    /// "rejada" | "tez ketmoqda" | "ulush tugadi".
    public static func statusText(_ p: WeeklyPace) -> String {
        switch p.status {
        case .onTrack: return "rejada"
        case .fast: return "tez ketmoqda"
        case .exceeded: return "ulush tugadi"
        case .unknown: return "—"
        }
    }

    public enum Level: Equatable, Sendable { case normal, warn, critical }

    public static func level(_ p: WeeklyPace) -> Level {
        switch p.status {
        case .exceeded: return .critical
        case .fast: return .warn
        default: return .normal
        }
    }

    /// Bar to'lishi 0...100 (ulushning foizi; oshib ketsa 100 da to'xtaydi).
    public static func barPct(_ p: WeeklyPace) -> Double { min(max(p.pctOfAllowance, 0), 100) }

    /// "shu tezlikda 15:40 da tugaydi" yoki "hafta oxirigacha yetadi" (bashorat yo'q = nil). Taxmin bo'lsa "≈" bilan.
    public static func forecast(_ p: WeeklyPace, now: Date, calendar: Calendar = .current) -> String? {
        guard let beforeReset = p.exhaustBeforeReset, let exhaustAt = p.exhaustAt.flatMap(ContractDates.parse) else { return nil }
        let a = isEstimate(p) ? "≈ " : ""
        if !beforeReset { return "\(a)shu tezlikda hafta oxirigacha yetadi" }
        if exhaustAt <= now { return "\(a)shu tezlikda hozir tugayapti" }
        return "\(a)shu tezlikda \(LimitFormat.clock(exhaustAt, now: now, calendar: calendar)) da tugaydi"
    }

    /// Izoh: "taxmin" / "rasmiy kuzatuv eskirgan" / nil.
    public static func note(_ p: WeeklyPace) -> String? {
        if isEstimate(p) { return "taxmin" }
        if p.stale { return "kuzatuv eskirgan" }
        return nil
    }

    /// "Bugun uchun ruxsat" / "yangi sessiyalar kechiktirilmoqda" / nil.
    public static func gateNote(_ p: WeeklyPace) -> String? {
        if p.overriddenToday { return "bugun uchun ruxsat berilgan" }
        if p.blocked { return "yangi sessiyalar kechiktirilmoqda" }
        return nil
    }

    /// Ixcham bir qator: "Bugun 9,8% / 18,0% (54%) · rejada".
    public static func compactLine(_ p: WeeklyPace) -> String {
        "Bugun \(share(p)) · \(statusText(p))"
    }

    public static func accessibility(_ p: WeeklyPace, now: Date, calendar: Calendar = .current) -> String {
        var s = "Bugungi haftalik ulush \(isEstimate(p) ? "taxminan " : "")\(comma1(p.usedTodayPct)) foiz, ulush \(comma1(p.allowancePct)) foiz, \(Int(p.pctOfAllowance.rounded())) foiz ishlatilgan, \(statusText(p))"
        if let f = forecast(p, now: now, calendar: calendar) { s += ", \(f.replacingOccurrences(of: "≈", with: "taxminan"))" }
        return s
    }
}
