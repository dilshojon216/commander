import Foundation

/// Yon menyu bo'limi. Tartib: birinchi to'qqiztasi ⌘1...⌘9 (docs/NATIVE-DASHBOARD.md, 3.4), qolganlari keyin.
public enum SidebarSection: CaseIterable, Hashable, Sendable {
    case overview, sessions, projects, machines, alerts, queue, tokens, search, templates
    case reports, billing, security, budgets, settings, settingsSync, admin, help

    public var title: String {
        switch self {
        case .overview: "Umumiy"
        case .sessions: "Sessiyalar"
        case .projects: "Loyihalar"
        case .machines: "Mashinalar"
        case .alerts: "Ogohlantirishlar"
        case .queue: "Navbat"
        case .tokens: "Tokenlar"
        case .search: "Qidiruv"
        case .templates: "Shablonlar"
        case .reports: "Hisobotlar"
        case .billing: "Hisob-kitob"
        case .security: "Xavfsizlik"
        case .budgets: "Byudjetlar"
        case .settings: "Umumiy sozlamalar"
        case .settingsSync: "Sozlamalar sinxroni"
        case .admin: "Boshqaruv"
        case .help: "Yo'riqnoma"
        }
    }

    /// ⌘ + raqam (1...9); qolgan bo'limlarda yorliq yo'q.
    public var shortcutDigit: Int? {
        guard let index = Self.allCases.firstIndex(of: self), index < 9 else { return nil }
        return index + 1
    }

    /// Bo'limning bosh sahifasi.
    public var root: Route {
        switch self {
        case .overview: .overview
        case .sessions: .sessions
        case .projects: .projects
        case .machines: .machines
        case .alerts: .alerts
        case .queue: .queue
        case .tokens: .tokens
        case .search: .search
        case .templates: .templates
        case .reports: .reports
        case .billing: .billing
        case .security: .security
        case .budgets: .budgets
        case .settings: .settings
        case .settingsSync: .settingsSync
        case .admin: .admin
        case .help: .help
        }
    }

    public static func forShortcut(digit: Int) -> SidebarSection? {
        allCases.first { $0.shortcutDigit == digit }
    }
}
