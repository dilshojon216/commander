import Foundation
import MenuBarCore
import UserNotifications

/// UNUserNotificationCenter: approval (Ruxsat [authenticationRequired] / Rad), javob kutish, limit bashorati, salomatlik.
/// Faqat `.app` ichida ishlaydi (bundle id kerak); `swift run` da jim o'tkazib yuboriladi.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    /// (approvalId, behavior) — bildirishnoma tugmasi bosilganda.
    var onDecision: ((String, ApprovalBehaviorChoice) -> Void)?
    /// Bildirishnoma bosildi: sahifa bo'lsa dashboard oynasi, aks holda panel.
    var onOpen: ((DashboardTarget?) -> Void)?

    enum ApprovalBehaviorChoice: Sendable { case allow, deny }

    private var center: UNUserNotificationCenter? { DeviceInfo.isBundled ? UNUserNotificationCenter.current() : nil }

    func setup() {
        guard let center else { return }
        center.delegate = self
        let allow = UNNotificationAction(identifier: NotificationActionID.allow, title: "Ruxsat", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: NotificationActionID.deny, title: "Rad", options: [.destructive])
        func cat(_ id: NotificationCategoryID, _ actions: [UNNotificationAction]) -> UNNotificationCategory {
            UNNotificationCategory(identifier: id.rawValue, actions: actions, intentIdentifiers: [], options: [])
        }
        center.setNotificationCategories([
            cat(.approval, [allow, deny]),
            cat(.approvalDenyOnly, [deny]),
            cat(.approvalReadOnly, []),
            cat(.waiting, []), cat(.limit, []), cat(.health, []), cat(.done, []),
        ])
    }

    func requestAuthorization() {
        center?.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error { log.error("notification auth: \(error.localizedDescription, privacy: .public)") }
            log.info("notification auth granted=\(granted, privacy: .public)")
        }
    }

    func post(_ spec: NotificationSpec) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = spec.title
        content.body = spec.body
        content.categoryIdentifier = spec.category.rawValue
        content.threadIdentifier = spec.category.rawValue
        var info: [String: String] = [:]
        if let id = spec.approvalId { info["approvalId"] = id }
        if let t = spec.target { info["dashboardPath"] = t.path }
        content.userInfo = info
        if spec.category == .approval || spec.category == .approvalDenyOnly {
            content.sound = .default
            content.interruptionLevel = .timeSensitive
        }
        center.add(UNNotificationRequest(identifier: spec.id, content: content, trigger: nil))
    }

    func remove(id: String) {
        center?.removeDeliveredNotifications(withIdentifiers: [id])
        center?.removePendingNotificationRequests(withIdentifiers: [id])
    }

    func removeAll() {
        center?.removeAllDeliveredNotifications()
    }

    // MARK: delegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let action = response.actionIdentifier
        let info = response.notification.request.content.userInfo
        let approvalId = info["approvalId"] as? String
        let path = info["dashboardPath"] as? String
        await MainActor.run {
            DebugLog.write("notification click action=\(action) path=\(path ?? "-") \(DebugLog.windowState())")
            switch action {
            case NotificationActionID.allow:
                if let approvalId { self.onDecision?(approvalId, .allow) }
            case NotificationActionID.deny:
                if let approvalId { self.onDecision?(approvalId, .deny) }
            default:
                // Yo'l qayta tekshiriladi (DashboardTarget(path:)); yaroqsiz bo'lsa panel.
                self.onOpen?(path.flatMap(DashboardTarget.init(path:)))
            }
        }
    }
}
