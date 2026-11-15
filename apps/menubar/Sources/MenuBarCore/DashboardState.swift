import CommanderContracts
import Foundation

/// REST snapshot: `/ws/client` ga obuna bo'lgandan KEYIN olinadi (PLAN §8: avval subscribe, keyin snapshot).
public struct DashboardSnapshot: Sendable, Equatable {
    public var sessions: [SessionDto]
    public var machines: [MachineDto]
    public var limits: LimitsResponse?
    public var pendingApprovals: [ApprovalDto]
    public var alerts: [AlertDto]
    public var health: HealthSummaryResponse?
    public var queue: [QueueItemDto]

    public init(
        sessions: [SessionDto] = [], machines: [MachineDto] = [], limits: LimitsResponse? = nil,
        pendingApprovals: [ApprovalDto] = [], alerts: [AlertDto] = [], health: HealthSummaryResponse? = nil,
        queue: [QueueItemDto] = []
    ) {
        self.sessions = sessions
        self.machines = machines
        self.limits = limits
        self.pendingApprovals = pendingApprovals
        self.alerts = alerts
        self.health = health
        self.queue = queue
    }
}

/// Reduktor chiqaradigan hodisalar: bildirishnoma va maskot pop-up shu yerdan boshqariladi.
public enum DashboardEvent: Equatable, Sendable {
    case approvalRequested(ApprovalDto)
    case approvalResolved(ApprovalDto)
    case sessionWaiting(SessionDto)
    case sessionDone(SessionDto)
    case healthDegraded(machineId: String, name: String, status: HealthStatus)
    case alertOpened(AlertDto)
    case lockdownChanged(Bool)
}

/// Panel ko'rsatadigan butun holat. Sof qiymat tipi: WS xabari / snapshot -> yangi holat + hodisalar.
public struct DashboardState: Sendable, Equatable {
    public var sessions: [String: SessionDto] = [:]
    public var machines: [String: MachineDto] = [:]
    public var limits: LimitsResponse?
    public var pendingApprovals: [String: ApprovalDto] = [:]
    public var openAlerts: [String: AlertDto] = [:]
    public var health: [String: HealthSummaryItem] = [:]
    public var queue: [String: QueueItemDto] = [:]
    public var lockdown = false
    /// `auth.ok` yoki `/v1/devices/me` dan (xom qiymatlar: kelajakdagi scope ham saqlanadi).
    public var scopes: Set<String> = []
    /// Yaqinda `done` ga o'tgan sessiyalar (maskot "tugatdi" pozasi). Panel ochilganda tozalanadi.
    public var recentlyDone: [String: Date] = [:]
    /// Snapshot hech bo'lmasa bir marta kelganmi (UI "yuklanmoqda" holati uchun).
    public var hasSnapshot = false

    public init() {}

    public var canApprove: Bool { scopes.contains(ClientTokenScope.approve.rawValue) }

    // MARK: snapshot

    /// Butun holatni almashtiradi. Ilgari ma'lum bo'lmagan pending approval'lar uchun hodisa qaytaradi
    /// (offline paytida kelgan so'rovlar ham bildirishnoma oladi; takroriy ulanishda takrorlanmaydi).
    @discardableResult
    public mutating func applySnapshot(_ snap: DashboardSnapshot, now: Date = Date()) -> [DashboardEvent] {
        var events: [DashboardEvent] = []
        let knownApprovals = Set(pendingApprovals.keys)
        sessions = Dictionary(snap.sessions.filter { $0.status != .ended }.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        machines = Dictionary(snap.machines.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        limits = snap.limits
        let pending = snap.pendingApprovals.filter { $0.status == .pending }
        pendingApprovals = Dictionary(pending.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        openAlerts = Dictionary(snap.alerts.filter { $0.state == .open }.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        health = Dictionary((snap.health?.items ?? []).map { ($0.machineId, $0) }, uniquingKeysWith: { $1 })
        queue = Dictionary(snap.queue.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        recentlyDone = recentlyDone.filter { sessions[$0.key]?.status == .done }
        // Ruxsat so'rovlari birinchi snapshot'da ham e'lon qilinadi: ular javob kutmoqda (sessiya/alert esa yo'q).
        for a in pending.sorted(by: { $0.requestedAt < $1.requestedAt }) where !knownApprovals.contains(a.id) {
            events.append(.approvalRequested(a))
        }
        hasSnapshot = true
        return events
    }

    // MARK: WS

    @discardableResult
    public mutating func apply(_ message: ServerToClientMessage, now: Date = Date()) -> [DashboardEvent] {
        switch message {
        case .authOk(let m):
            scopes = Set(m.payload.scopes.map(\.rawValue))
            return setLockdown(m.payload.lockdown.enabled)
        case .sessionUpdated(let m):
            return upsertSession(m.payload.session, now: now)
        case .machineUpdated(let m):
            machines[m.payload.machine.id] = m.payload.machine
            return []
        case .limitsUpdated(let m):
            limits = m.payload.limits
            return []
        case .approvalCreated(let m):
            return upsertApproval(m.payload.approval)
        case .approvalResolved(let m):
            return upsertApproval(m.payload.approval)
        case .lockdownUpdated(let m):
            return setLockdown(m.payload.enabled)
        case .alertCreated(let m):
            return upsertAlert(m.payload.alert, isNew: true)
        case .alertUpdated(let m):
            return upsertAlert(m.payload.alert, isNew: false)
        case .machineHealth(let m):
            return updateHealth(machineId: m.payload.machineId, status: m.payload.status, receivedAt: m.payload.receivedAt)
        case .queueUpdated(let m):
            queue[m.payload.item.id] = m.payload.item
            return []
        default:
            return []
        }
    }

    /// REST qaror javobi (`ApprovalDecisionResponse.approval`) yoki WS orqali kelgan approval.
    @discardableResult
    public mutating func upsertApproval(_ a: ApprovalDto) -> [DashboardEvent] {
        if a.status == .pending {
            let isNew = pendingApprovals[a.id] == nil
            pendingApprovals[a.id] = a
            return isNew ? [.approvalRequested(a)] : []
        }
        if pendingApprovals.removeValue(forKey: a.id) != nil {
            return [.approvalResolved(a)]
        }
        return []
    }

    /// 409 (allaqachon hal qilingan / muddati o'tgan) dan keyin kartani ro'yxatdan olib tashlash.
    public mutating func dropApproval(id: String) {
        pendingApprovals.removeValue(forKey: id)
    }

    /// REST 403 `lockdown` javobidan keyin (WS xabarini kutmasdan).
    @discardableResult
    public mutating func markLockdown(_ enabled: Bool) -> [DashboardEvent] {
        setLockdown(enabled)
    }

    public mutating func acknowledgeDone() {
        recentlyDone.removeAll()
    }

    /// `ttl` dan eski "tugatdi" belgilarini tashlaydi.
    public mutating func expireDone(now: Date, ttl: TimeInterval = 10 * 60) {
        recentlyDone = recentlyDone.filter { now.timeIntervalSince($0.value) < ttl }
    }

    // MARK: private

    private mutating func setLockdown(_ enabled: Bool) -> [DashboardEvent] {
        guard enabled != lockdown else { return [] }
        lockdown = enabled
        return [.lockdownChanged(enabled)]
    }

    private mutating func upsertSession(_ s: SessionDto, now: Date) -> [DashboardEvent] {
        let old = sessions[s.id]
        if s.status == .ended {
            sessions.removeValue(forKey: s.id)
            recentlyDone.removeValue(forKey: s.id)
            return []
        }
        sessions[s.id] = s
        guard old?.status != s.status else { return [] }
        switch s.status {
        case .waiting:
            recentlyDone.removeValue(forKey: s.id)
            return [.sessionWaiting(s)]
        case .done:
            // Birinchi marta ko'rilgan (snapshot'da bo'lmagan) `done` sessiya ham "tugatdi" hisoblanadi:
            // u faqat session.updated orqali keladi, ya'ni hozirgina tugagan.
            recentlyDone[s.id] = now
            return [.sessionDone(s)]
        default:
            recentlyDone.removeValue(forKey: s.id)
            return []
        }
    }

    private mutating func upsertAlert(_ a: AlertDto, isNew: Bool) -> [DashboardEvent] {
        guard a.state == .open else {
            openAlerts.removeValue(forKey: a.id)
            return []
        }
        let known = openAlerts[a.id] != nil
        openAlerts[a.id] = a
        return (isNew && !known) ? [.alertOpened(a)] : []
    }

    private mutating func updateHealth(machineId: String, status: HealthStatus, receivedAt: String) -> [DashboardEvent] {
        let old = health[machineId]
        let name = old?.name ?? machines[machineId].map(Self.machineName) ?? String(machineId.prefix(8))
        let online = status != .offline
        health[machineId] = HealthSummaryItem(
            machineId: machineId, name: name, online: online, status: status,
            cpuPct: old?.cpuPct, memPct: old?.memPct, diskMaxPct: old?.diskMaxPct, diskMaxMount: old?.diskMaxMount,
            containersTotal: old?.containersTotal ?? 0, containersBad: old?.containersBad ?? 0,
            failedUnits: old?.failedUnits ?? 0, receivedAt: receivedAt, openIncidents: old?.openIncidents ?? 0
        )
        let oldStatus = old?.status ?? .unknownValue
        let degraded = (status == .critical && oldStatus != .critical) || (status == .offline && oldStatus != .offline && old != nil)
        return degraded ? [.healthDegraded(machineId: machineId, name: name, status: status)] : []
    }

    /// machineId -> ko'rsatiladigan nom (slug xeshli va uzun: DESIGN-BRIEF §5).
    public var machineNames: [String: String] { machines.mapValues(Self.machineName) }

    public static func machineName(_ m: MachineDto) -> String {
        m.displayName ?? m.hostname ?? m.slug
    }
}
