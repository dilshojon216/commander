import DashboardCore

extension SidebarSection {
    /// SF Symbols belgisi.
    var symbol: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .sessions: "terminal"
        case .projects: "folder"
        case .machines: "server.rack"
        case .alerts: "exclamationmark.triangle"
        case .queue: "clock"
        case .tokens: "chart.bar"
        case .search: "magnifyingglass"
        case .templates: "text.badge.plus"
        case .reports: "doc.text"
        case .billing: "creditcard"
        case .security: "lock.shield"
        case .budgets: "gauge.with.dots.needle.50percent"
        case .settings: "gearshape"
        case .settingsSync: "arrow.triangle.2.circlepath"
        case .admin: "wrench.and.screwdriver"
        case .help: "questionmark.circle"
        }
    }
}
