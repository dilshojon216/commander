import AppKit
import CommanderContracts
import DashboardCore
import Foundation
import MenuBarCore
import SwiftUI

/// Ilova holati va oqimlari: pairing, REST snapshot + `/ws/client`, approvals, bildirishnoma, maskot.
@MainActor @Observable
final class AppModel {
    let settings = AppSettings()
    var state = DashboardState()
    var connection: ConnectionStatus = .unpaired
    var me: ClientDeviceMeResponse?
    var flow = ApprovalFlow()
    /// Hal bo'lgan, lekin natija xabari bir necha soniya ko'rinib turadigan kartalar.
    var fading: [String: (approval: ApprovalDto, message: String)] = [:]
    var panelVisible = false
    /// Panelni dasturiy ochish (bildirishnoma / maskot bosilganda); `StatusPanelController` o'rnatadi.
    @ObservationIgnored var panelOpener: (() -> Void)?
    @ObservationIgnored var panelCloser: (() -> Void)?
    var showSettings = false
    /// Token Keychain'dan o'qilmoqda (ruxsat oynasi javob kutayotgan bo'lishi mumkin).
    var loadingToken = false
    var lastError: String?

    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored lazy var popup = MascotPopupController(model: self)
    @ObservationIgnored lazy var pairingWindow = PairingWindowController(model: self)
    @ObservationIgnored let dock = DockPresence()
    @ObservationIgnored lazy var dashboardWindow = DashboardWindowController(settings: settings, dock: dock)
    @ObservationIgnored lazy var nativeDashboard = NativeDashboardWindowController(model: self, dock: dock)
    /// Butun ilova uchun bitta `/ws/client` ulanishi (qayta ulanish va obuna shu yerda; docs/NATIVE-DASHBOARD.md 3.3).
    @ObservationIgnored let hub = LiveHub(socket: URLSessionLiveSocket())
    @ObservationIgnored var token: String?
    @ObservationIgnored var liveTask: Task<Void, Never>?
    @ObservationIgnored var forecastWatcher = LimitForecastWatcher()
    @ObservationIgnored var ticker: Task<Void, Never>?
    @ObservationIgnored var started = false

    var summary: DashboardSummary { DashboardSummary(state: state) }
    var mood: MascotMood { MascotMood.from(summary: summary, connection: connection) }
    var menuText: String {
        MenuText.format(summary: summary, limits: state.limits, connection: connection, format: settings.textFormat, window: settings.limitWindow)
    }
    var isPaired: Bool { preview || (token != nil && settings.centerURL != nil) }
    @ObservationIgnored var preview = false

    /// Faqat `--render-previews` uchun: fixture snapshot'ini tarmoqsiz yuklaydi.
    func loadPreview(_ snap: DashboardSnapshot, scopes: Set<String>) {
        preview = true
        state.applySnapshot(snap)
        state.scopes = scopes
        connection = .live
    }

    var sortedApprovals: [ApprovalDto] {
        state.pendingApprovals.values.sorted { $0.requestedAt < $1.requestedAt }
    }

    var projectGroups: [ProjectGroup] { ProjectGroup.group(Array(state.sessions.values)) }

    // MARK: ishga tushish

    func start() {
        guard !started else { return }
        started = true
        notifier.setup()
        notifier.onDecision = { [weak self] id, choice in
            Task { await self?.decideFromNotification(id: id, choice: choice) }
        }
        notifier.onOpen = { [weak self] target in
            if let target { self?.openDashboard(target) } else { self?.openPanel() }
        }
        // COMMANDER_MENUBAR_SMOKE=1: tutun sinovi (build skripti / CI) — tizim dialoglari va "Ulash" oynasi ochilmaydi.
        let smoke = ProcessInfo.processInfo.environment["COMMANDER_MENUBAR_SMOKE"] == "1"
        if settings.notificationsEnabled && !smoke { notifier.requestAuthorization() }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                self?.tick()
            }
        }
        // Keychain so'rovi ruxsat oynasini kutib qolishi mumkin (imzo o'zgarganda): asosiy oqimni bloklamaslik uchun fonda.
        loadingToken = true
        Task { [weak self] in
            // Global navbatda: Keychain kutishi Swift concurrency pool'ini band qilmasin.
            let token = await withCheckedContinuation { cont in
                DispatchQueue.global(qos: .userInitiated).async { cont.resume(returning: TokenStore.load()) }
            }
            guard let self else { return }
            self.loadingToken = false
            self.token = token
            if self.isPaired {
                self.connect()
            } else {
                self.connection = .unpaired
                if !smoke { self.pairingWindow.show(prefill: nil) }
            }
        }
    }

    func tick() {
        let now = Date()
        state.expireDone(now: now)
        checkForecast(now: now)
    }
}
