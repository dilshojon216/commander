import CommanderContracts
import Foundation

/// Bildirishnoma toifalari (UNNotificationCategory identifikatorlari).
public enum NotificationCategoryID: String, Sendable, CaseIterable {
    /// Ruxsat + Rad tugmalari.
    case approval = "uz.commander.approval"
    /// Faqat Rad (reja, savol yoki lockdown).
    case approvalDenyOnly = "uz.commander.approval.deny"
    /// Tugmasiz (approve scope yo'q).
    case approvalReadOnly = "uz.commander.approval.read"
    case waiting = "uz.commander.waiting"
    case limit = "uz.commander.limit"
    case health = "uz.commander.health"
    case done = "uz.commander.done"
}

public enum NotificationActionID {
    public static let allow = "uz.commander.action.allow"
    public static let deny = "uz.commander.action.deny"
}

/// Platformadan mustaqil bildirishnoma tavsifi.
public struct NotificationSpec: Equatable, Sendable {
    /// Bir xil id = almashtiriladi (takror chiqmaydi).
    public let id: String
    public let category: NotificationCategoryID
    public let title: String
    public let body: String
    public let approvalId: String?
    /// Bosilganda ochiladigan dashboard sahifasi (nil = panel).
    public let target: DashboardTarget?

    public init(id: String, category: NotificationCategoryID, title: String, body: String, approvalId: String? = nil, target: DashboardTarget? = nil) {
        self.id = id
        self.category = category
        self.title = title
        self.body = body
        self.approvalId = approvalId
        self.target = target
    }
}

/// Maskot pop-up tavsifi ("burchakdan chiqish").
public struct PopupSpec: Equatable, Sendable {
    public let pose: MascotPose
    public let light: MascotLight
    public let title: String
    public let text: String
    /// nil = so'rov hal bo'lguncha (lekin `maxVisible` dan oshmaydi).
    public let autoHide: TimeInterval?
    public let approvalId: String?
    /// "Ko'rish/Ochish" bosilganda ochiladigan dashboard sahifasi (nil = panel).
    public let target: DashboardTarget?
    public static let maxVisible: TimeInterval = 90

    public init(pose: MascotPose, light: MascotLight, title: String, text: String, autoHide: TimeInterval?, approvalId: String?, target: DashboardTarget? = nil) {
        self.pose = pose
        self.light = light
        self.title = title
        self.text = text
        self.autoHide = autoHide
        self.approvalId = approvalId
        self.target = target
    }
}

public enum EventPlanner {
    public static func notification(for event: DashboardEvent, canApprove: Bool, lockdown: Bool, machineNames: [String: String] = [:]) -> NotificationSpec? {
        switch event {
        case .approvalRequested(let a):
            let category: NotificationCategoryID
            if !canApprove { category = .approvalReadOnly }
            else if a.kind == .plan || a.kind == .question || lockdown { category = .approvalDenyOnly }
            else { category = .approval }
            let title = a.kind == .plan ? "\(ApprovalText.project(a)) reja tasdig'ini so'rayapti"
                : (a.kind == .question ? "\(ApprovalText.project(a)) savol bermoqda" : "\(ApprovalText.project(a)) ruxsat so'rayapti")
            return NotificationSpec(id: "approval-\(a.id)", category: category, title: title,
                                    body: "\(machineNames[a.machineId] ?? a.machineSlug) · \(ApprovalText.summary(a, max: 140))", approvalId: a.id,
                                    target: DashboardTarget.forEvent(event))
        case .sessionWaiting(let s):
            let msg = s.message.map { ": \"\(ApprovalText.truncate($0, max: 120))\"" } ?? ""
            return NotificationSpec(id: "waiting-\(s.id)", category: .waiting, title: "\(s.projectName) javob kutyapti",
                                    body: "\(s.machineName)\(msg)", target: DashboardTarget.forEvent(event))
        case .healthDegraded(let id, let name, let status):
            let what = status == .offline ? "oflayn" : "jiddiy holatda"
            return NotificationSpec(id: "health-\(id)-\(status.rawValue)", category: .health, title: "\(name) \(what)",
                                    body: "Server salomatligi: \(StatusText.health(status))", target: DashboardTarget.forEvent(event))
        case .alertOpened(let a):
            return NotificationSpec(id: "alert-\(a.id)", category: .waiting, title: a.title,
                                    body: "\(a.projectName ?? a.sessionName ?? "") · \(a.detail)", target: DashboardTarget.forEvent(event))
        case .sessionDone, .approvalResolved, .lockdownChanged:
            return nil
        }
    }

    public static func popup(for event: DashboardEvent, now: Date, machineNames: [String: String] = [:]) -> PopupSpec? {
        switch event {
        case .approvalRequested(let a):
            let left = ApprovalText.remaining(a, now: now).map { " · \($0) qoldi" } ?? ""
            return PopupSpec(pose: .ruxsat, light: .orange, title: "\(ApprovalText.project(a)) ruxsat so'rayapti",
                             text: "\(machineNames[a.machineId] ?? a.machineSlug) · \(ApprovalText.summary(a, max: 90))\(left)", autoHide: nil, approvalId: a.id,
                             target: DashboardTarget.forEvent(event))
        case .sessionWaiting(let s):
            let msg = s.message.map { ": \"\(ApprovalText.truncate($0, max: 90))\"" } ?? ""
            return PopupSpec(pose: .kutmoqda, light: .yellow, title: "\(s.projectName) javob kutyapti",
                             text: "\(s.machineName)\(msg)", autoHide: 8, approvalId: nil, target: DashboardTarget.forEvent(event))
        case .sessionDone(let s):
            return PopupSpec(pose: .tugatdi, light: .green, title: "\(s.projectName) ishini tugatdi",
                             text: s.machineName, autoHide: 8, approvalId: nil, target: DashboardTarget.forEvent(event))
        default:
            return nil
        }
    }
}

/// Limit bashorati bildirishnomasi: oyna yangilanishidan OLDIN tugashi `lead` ichida bo'lsa, har oyna (resetsAt) uchun bir marta.
public struct LimitForecastWatcher: Sendable, Equatable {
    public private(set) var notified: Set<String> = []
    public var lead: TimeInterval

    public init(lead: TimeInterval = 60 * 60) { self.lead = lead }

    public mutating func check(_ limits: LimitsResponse?, now: Date) -> NotificationSpec? {
        guard let limits else { return nil }
        for (key, title, w) in [("5h", "5 soatlik", limits.fiveHour), ("7d", "Haftalik", limits.sevenDay)] {
            guard let w, let f = w.forecast, f.beforeReset, let at = ContractDates.parse(f.exhaustsAt) else { continue }
            let left = at.timeIntervalSince(now)
            guard left > 0, left <= lead else { continue }
            let dedup = "\(key)-\(f.resetsAt ?? w.resetsAt ?? "")"
            guard !notified.contains(dedup) else { continue }
            notified.insert(dedup)
            return NotificationSpec(
                id: "limit-\(dedup)", category: .limit, title: "\(title) limit tez orada tugaydi",
                body: "\(LimitFormat.forecast(w, now: now) ?? "") (taxmin) · hozir \(LimitFormat.percent(w))",
                target: .usage
            )
        }
        return nil
    }
}
