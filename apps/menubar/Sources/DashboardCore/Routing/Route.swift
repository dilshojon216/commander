import Foundation
import MenuBarCore

/// Dashboard sahifasi (native marshrut). Web yo'llari bilan bir xil (`docs/NATIVE-DASHBOARD.md`, 3.4); mavjud `DashboardTarget`
/// (bildirishnoma/maskot chuqur havolalari) shuning kengaytmasi: eski yo'llar va ularning tekshiruvi saqlanadi.
public enum Route: Hashable, Sendable {
    case overview
    case sessions, session(String)
    case projects, project(String), projectWork(String)
    case machines, machine(String), addMachine
    case alerts, queue, tokens, search, templates
    case reports, report(String), billing
    case security, scan(String)
    case budgets, settings, settingsSync, admin
    case help, helpDoc(String)

    /// Yo'riqnoma hujjatlari: faqat shu slug'lar (web `lib/help-docs.ts` `HELP_DOCS` bilan bir xil).
    public static let helpSlugs: Set<String> = ["remote-control", "add-server"]

    public var section: SidebarSection {
        switch self {
        case .overview: .overview
        case .sessions, .session: .sessions
        case .projects, .project, .projectWork: .projects
        case .machines, .machine, .addMachine: .machines
        case .alerts: .alerts
        case .queue: .queue
        case .tokens: .tokens
        case .search: .search
        case .templates: .templates
        case .reports, .report: .reports
        case .billing: .billing
        case .security, .scan: .security
        case .budgets: .budgets
        case .settings: .settings
        case .settingsSync: .settingsSync
        case .admin: .admin
        case .help, .helpDoc: .help
        }
    }

    /// Kanonik yo'l (chuqur havola `userInfo`si uchun; `init?(path:)` shuni qayta o'qiydi).
    public var path: String {
        switch self {
        case .overview: "/"
        case .sessions: "/sessions"
        case .session(let id): "/sessions/\(id)"
        case .projects: "/projects"
        case .project(let id): "/projects/\(id)"
        case .projectWork(let id): "/projects/\(id)/work"
        case .machines: "/machines"
        case .machine(let id): "/machines/\(id)"
        case .addMachine: "/machines/new"
        case .alerts: "/alerts"
        case .queue: "/queue"
        case .tokens: "/tokens"
        case .search: "/search"
        case .templates: "/templates"
        case .reports: "/reports"
        case .report(let id): "/reports/\(id)"
        case .billing: "/billing"
        case .security: "/security"
        case .scan(let id): "/security/\(id)"
        case .budgets: "/budgets"
        case .settings: "/settings"
        case .settingsSync: "/settings-sync"
        case .admin: "/admin"
        case .help: "/help"
        case .helpDoc(let slug): "/help/\(slug)"
        }
    }

    /// Web dashboard'dagi mos yo'l ("Web ko'rinishda ochish" uchun); web'da yo'q sahifalar (mashina qo'shish ustasi, Boshqaruv) uchun `nil`.
    public var webPath: String? {
        switch self {
        case .addMachine, .admin: nil
        default: path
        }
    }

    // MARK: yo'ldan o'qish

    private static let fixed: [String: Route] = [
        "": .overview, "sessions": .sessions, "projects": .projects, "machines": .machines, "alerts": .alerts, "queue": .queue,
        "tokens": .tokens, "usage": .tokens, "search": .search, "templates": .templates, "reports": .reports, "billing": .billing,
        "security": .security, "budgets": .budgets, "settings": .settings, "settings-sync": .settingsSync, "admin": .admin, "help": .help,
    ]

    /// Yo'lni (bildirishnoma `userInfo`dan) xavfsiz qayta tiklaydi; id'lar `DashboardTarget.validID` bilan tekshiriladi.
    /// `/usage` — `/tokens` ning eski nomi. Noma'lum/yaroqsiz yo'l -> nil.
    public init?(path: String) {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.first == "" else { return nil }
        let rest = Array(parts.dropFirst())
        switch rest.count {
        case 1:
            guard let route = Self.fixed[rest[0]] else { return nil }
            self = route
        case 2:
            guard let route = Self.detail(section: rest[0], id: rest[1]) else { return nil }
            self = route
        case 3:
            guard rest[0] == "projects", rest[2] == "work", DashboardTarget.validID(rest[1]) else { return nil }
            self = .projectWork(rest[1])
        default:
            return nil
        }
    }

    private static func detail(section: String, id: String) -> Route? {
        if section == "help" { return helpSlugs.contains(id) ? .helpDoc(id) : nil }
        if section == "machines", id == "new" { return .addMachine }
        guard DashboardTarget.validID(id) else { return nil }
        switch section {
        case "sessions": return .session(id)
        case "projects": return .project(id)
        case "machines": return .machine(id)
        case "reports": return .report(id)
        case "security": return .scan(id)
        default: return nil
        }
    }

    // MARK: DashboardTarget bilan moslik

    public init(target: DashboardTarget) {
        switch target {
        case .overview: self = .overview
        case .session(let id): self = .session(id)
        case .project(let id): self = .project(id)
        case .projectWork(let id): self = .projectWork(id)
        case .machine(let id): self = .machine(id)
        case .alerts: self = .alerts
        case .usage: self = .tokens
        case .queue: self = .queue
        }
    }

    /// Eski chuqur havola turi (web rejimidagi `DashboardWindow` shuni ochadi); unga mos kelmaydigan sahifalar uchun `nil`.
    public var dashboardTarget: DashboardTarget? {
        switch self {
        case .overview: .overview
        case .session(let id): .session(id)
        case .project(let id): .project(id)
        case .projectWork(let id): .projectWork(id)
        case .machine(let id): .machine(id)
        case .alerts: .alerts
        case .tokens: .usage
        case .queue: .queue
        default: nil
        }
    }
}
