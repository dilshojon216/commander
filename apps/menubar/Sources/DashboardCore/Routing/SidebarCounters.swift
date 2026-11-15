import Foundation
import MenuBarCore

/// Yon menyu hisoblagichlari (jonli): sessiyalar soni va kutayotgan ruxsatlar, mashinalar onlayn/jami, ochiq ogohlantirishlar.
/// Loyihalar soni (`projects`) ekran yuklangach qo'shiladi, shuning uchun hozir `nil`.
public struct SidebarCounters: Equatable, Sendable {
    public let sessions: Int
    public let pendingApprovals: Int
    public let onlineMachines: Int
    public let totalMachines: Int
    public let openAlerts: Int
    public let projects: Int?

    public init(sessions: Int = 0, pendingApprovals: Int = 0, onlineMachines: Int = 0, totalMachines: Int = 0, openAlerts: Int = 0, projects: Int? = nil) {
        self.sessions = sessions
        self.pendingApprovals = pendingApprovals
        self.onlineMachines = onlineMachines
        self.totalMachines = totalMachines
        self.openAlerts = openAlerts
        self.projects = projects
    }

    /// Faol sessiyalar: ishlayapti + kutmoqda + bo'sh (tugagan va eskirganlar hisobga olinmaydi).
    public init(summary: DashboardSummary, projects: Int? = nil) {
        self.init(
            sessions: summary.working + summary.waiting + summary.idle,
            pendingApprovals: summary.approvals,
            onlineMachines: summary.onlineMachines,
            totalMachines: summary.totalMachines,
            openAlerts: summary.openAlerts,
            projects: projects
        )
    }

    /// Chap tomondagi turtki belgi (diqqat talab qiladigan son); 0 bo'lsa yo'q.
    public func badge(for section: SidebarSection) -> Int? {
        switch section {
        case .sessions: pendingApprovals > 0 ? pendingApprovals : nil
        case .alerts: openAlerts > 0 ? openAlerts : nil
        default: nil
        }
    }

    /// O'ng tomondagi kulrang son.
    public func count(for section: SidebarSection) -> String? {
        switch section {
        case .sessions: String(sessions)
        case .projects: projects.map(String.init)
        case .machines: totalMachines > 0 ? "\(onlineMachines)/\(totalMachines)" : nil
        default: nil
        }
    }
}
