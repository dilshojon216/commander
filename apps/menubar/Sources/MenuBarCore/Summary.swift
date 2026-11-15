import CommanderContracts
import Foundation

/// Markaz bilan ulanish holati (menu-bar ikonkasi va offline banner uchun).
public enum ConnectionStatus: Equatable, Sendable {
    /// Token yo'q: "Ulash" oynasi kerak.
    case unpaired
    case connecting
    case live
    /// Uzildi, `retryAt` da qayta urinadi.
    case reconnecting(attempt: Int, retryAt: Date)
    /// Token rad etildi / revoke qilindi (4001/4010/401): qayta ulanmaymiz, qayta pairing kerak.
    case unauthorized(reason: String)

    public var isOnline: Bool { self == .live }
}

/// Holat bo'yicha yig'ma raqamlar (menu-bar matni, panel sarlavhasi, maskot).
public struct DashboardSummary: Equatable, Sendable {
    public var working = 0
    public var waiting = 0
    public var idle = 0
    public var done = 0
    public var stale = 0
    /// Pending approval'lar (approval ro'yxatidan, sessiya holatidan emas: aniqroq).
    public var approvals = 0
    public var onlineMachines = 0
    public var totalMachines = 0
    public var openAlerts = 0
    public var activeQueue = 0
    public var worstHealth: HealthStatus = .unknownValue
    public var worstHealthItem: HealthSummaryItem?
    public var recentlyDone = 0

    public init() {}

    public init(state: DashboardState) {
        for s in state.sessions.values {
            if s.staleSince != nil { stale += 1 }
            switch s.status {
            case .working: working += 1
            case .waiting: waiting += 1
            case .idle: idle += 1
            case .done: done += 1
            default: break
            }
        }
        approvals = state.pendingApprovals.count
        totalMachines = state.machines.count
        onlineMachines = state.machines.values.filter(\.online).count
        openAlerts = state.openAlerts.count
        activeQueue = state.queue.values.filter { Self.isActiveQueue($0.status) }.count
        recentlyDone = state.recentlyDone.count
        var worst: HealthSummaryItem?
        for item in state.health.values.sorted(by: { $0.name < $1.name }) {
            if worst == nil || HealthRank.rank(item.status) > HealthRank.rank(worst!.status) { worst = item }
        }
        worstHealthItem = worst
        worstHealth = worst?.status ?? .unknownValue
    }

    public static func isActiveQueue(_ s: QueueStatus) -> Bool {
        switch s {
        case .queued, .waitingTrigger, .starting: return true
        default: return false
        }
    }
}

/// center `health-merge.ts` RANK bilan bir xil: unknown < ok < offline < warn < critical.
public enum HealthRank {
    public static func rank(_ s: HealthStatus) -> Int {
        switch s {
        case .unknownValue, .unknown: return 0
        case .ok: return 1
        case .offline: return 2
        case .warn: return 3
        case .critical: return 4
        }
    }
}

// MARK: - Maskot

/// "Navbatchi" pozalari (dizayn: Mascot.dc.html).
public enum MascotPose: String, CaseIterable, Sendable {
    /// Javob kutmoqda: qo'l silkitadi, sariq chiroq.
    case kutmoqda
    /// Ruxsat so'rovi: ko'zlar katta, to'q sariq chiroq, sakraydi.
    case ruxsat
    /// Ishini tugatdi: ko'zlar kuladi, yashil chiroq.
    case tugatdi
    /// Hammasi tinch: mudraydi.
    case mudrayapti
}

/// Antenna chirog'i rangi (semantik; aniq rang UI'da: Theme).
public enum MascotLight: String, Sendable {
    case gray, blue, yellow, orange, green, red
}

public struct MascotMood: Equatable, Sendable {
    public var pose: MascotPose
    public var light: MascotLight
    /// Diqqat kerak (ikonka miltillaydi / rangli).
    public var needsAttention: Bool

    public init(pose: MascotPose, light: MascotLight, needsAttention: Bool) {
        self.pose = pose
        self.light = light
        self.needsAttention = needsAttention
    }

    /// Ustuvorlik: aloqa yo'q > ruxsat > javob kutmoqda > tugatdi > ishlamoqda > tinch.
    public static func from(summary: DashboardSummary, connection: ConnectionStatus) -> MascotMood {
        switch connection {
        case .unpaired:
            return MascotMood(pose: .mudrayapti, light: .gray, needsAttention: false)
        case .reconnecting, .unauthorized:
            return MascotMood(pose: .mudrayapti, light: .red, needsAttention: true)
        case .connecting, .live:
            break
        }
        if summary.approvals > 0 { return MascotMood(pose: .ruxsat, light: .orange, needsAttention: true) }
        if summary.waiting > 0 { return MascotMood(pose: .kutmoqda, light: .yellow, needsAttention: true) }
        if summary.recentlyDone > 0 { return MascotMood(pose: .tugatdi, light: .green, needsAttention: false) }
        if summary.working > 0 { return MascotMood(pose: .mudrayapti, light: .blue, needsAttention: false) }
        return MascotMood(pose: .mudrayapti, light: .gray, needsAttention: false)
    }
}
