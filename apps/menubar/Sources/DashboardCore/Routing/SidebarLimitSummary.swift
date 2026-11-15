import CommanderContracts
import Foundation
import MenuBarCore

/// Yon menyu pastidagi "Haftalik limit" kartasi. Taxmin rasmiydek ko'rsatilmaydi (CLAUDE.md #6): `isEstimate` bo'lsa "≈" va "taxmin".
public struct SidebarLimitSummary: Equatable, Sendable {
    public let percentText: String
    public let fraction: Double
    public let isEstimate: Bool
    public let level: LimitFormat.Level
    public let resetText: String?

    public init?(limits: LimitsResponse?, now: Date, calendar: Calendar = .current) {
        guard let window = limits?.sevenDay else { return nil }
        percentText = LimitFormat.percent(window)
        fraction = min(max(window.usedPct / 100, 0), 1)
        isEstimate = LimitFormat.isEstimate(window)
        level = LimitFormat.level(window)
        resetText = LimitFormat.resetText(window, now: now, calendar: calendar)
    }
}
