import AppKit
import CommanderContracts
import Foundation
import MenuBarCore
import SwiftUI

/// Ilova holati va oqimlari: pairing, REST snapshot + `/ws/client`, approvals, bildirishnoma, maskot.
@MainActor @Observable
final class AppModel {
    let settings = AppSettings()
    private(set) var state = DashboardState()
    private(set) var connection: ConnectionStatus = .unpaired
    private(set) var me: ClientDeviceMeResponse?
    private(set) var flow = ApprovalFlow()
    /// Hal bo'lgan, lekin natija xabari bir necha soniya ko'rinib turadigan kartalar.
    private(set) var fading: [String: (approval: ApprovalDto, message: String)] = [:]
    var panelVisible = false
    /// Panelni dasturiy ochish (bildirishnoma / maskot bosilganda); `StatusPanelController` o'rnatadi.
    @ObservationIgnored var panelOpener: (() -> Void)?
    @ObservationIgnored var panelCloser: (() -> Void)?
    var showSettings = false
    /// Token Keychain'dan o'qilmoqda (ruxsat oynasi javob kutayotgan bo'lishi mumkin).
    private(set) var loadingToken = false
    private(set) var lastError: String?

    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored lazy var popup = MascotPopupController(model: self)
    @ObservationIgnored lazy var pairingWindow = PairingWindowController(model: self)
    @ObservationIgnored lazy var dashboardWindow = DashboardWindowController(settings: settings)
    @ObservationIgnored private let socket = ClientSocket()
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var reconnect = ReconnectState()
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var forecastWatcher = LimitForecastWatcher()
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var started = false

    var summary: DashboardSummary { DashboardSummary(state: state) }
    var mood: MascotMood { MascotMood.from(summary: summary, connection: connection) }
    var menuText: String {
        MenuText.format(summary: summary, limits: state.limits, connection: connection, format: settings.textFormat, window: settings.limitWindow)
    }
    var isPaired: Bool { preview || (token != nil && settings.centerURL != nil) }
    @ObservationIgnored private var preview = false

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

    private func tick() {
        let now = Date()
        state.expireDone(now: now)
        checkForecast(now: now)
    }

    // MARK: ulanish

    func connect() {
        reconnectTask?.cancel()
        guard let token, let center = settings.centerURL, let ws = CenterURLs.webSocket(center: center) else {
            connection = .unpaired
            return
        }
        connection = .connecting
        socket.onMessage = { [weak self] msg in self?.handle(msg) }
        socket.onClose = { [weak self] code in self?.closed(code: code) }
        socket.connect(url: ws, token: token)
    }

    /// "Qayta ulash" tugmasi: backoff'ni kutmasdan.
    func reconnectNow() {
        reconnect.connected()
        connect()
    }

    private func closed(code: Int?) {
        let decision = CloseDecision.from(code: code)
        log.info("ws closed code=\(code ?? -1, privacy: .public)")
        guard let delay = reconnect.next(after: decision, random: Double.random(in: 0..<1)) else {
            if case .stop(let reason) = decision { connection = .unauthorized(reason: reason) }
            return
        }
        connection = .reconnecting(attempt: reconnect.attempt, retryAt: Date().addingTimeInterval(delay))
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    private func handle(_ msg: ServerToClientMessage) {
        switch msg {
        case .authOk:
            reconnect.connected()
            connection = .live
            dispatch(state.apply(msg))
            if let sub = ClientWire.subscribe() { socket.send(sub) }
        case .authError(let m):
            socket.disconnect()
            connection = .unauthorized(reason: "Token rad etildi (\(m.payload.code.rawValue)): qayta ulang")
        case .subscribed:
            // PLAN §8: avval subscribe, KEYIN REST snapshot.
            Task { await loadSnapshot() }
        default:
            dispatch(state.apply(msg))
            if case .limitsUpdated = msg { checkForecast(now: Date()) }
        }
    }

    private func loadSnapshot() async {
        guard let api else { return }
        do {
            let snap = try await api.snapshot()
            dispatch(state.applySnapshot(snap))
            lastError = nil
            checkForecast(now: Date())
            if let m = try? await api.me() {
                me = m
                state.scopes = Set(m.scopes.map(\.rawValue))
            }
        } catch .unauthorized {
            socket.disconnect()
            connection = .unauthorized(reason: "Token yaroqsiz yoki bekor qilingan: qayta ulang")
        } catch {
            lastError = error.message
        }
    }

    private var api: CenterAPI? {
        guard let token, let center = settings.centerURL else { return nil }
        return CenterAPI(center: center, token: token)
    }

    // MARK: hodisalar -> bildirishnoma / maskot

    private func dispatch(_ events: [DashboardEvent]) {
        let now = Date()
        for e in events {
            switch e {
            case .approvalResolved(let a):
                notifier.remove(id: "approval-\(a.id)")
                popup.dismiss(approvalId: a.id)
                flow.forget(a.id)
            default:
                break
            }
            if settings.notificationsEnabled,
               let spec = EventPlanner.notification(for: e, canApprove: state.canApprove, lockdown: state.lockdown, machineNames: state.machineNames) {
                notifier.post(spec)
            }
            if settings.mascotPopupsEnabled, !panelVisible, let p = EventPlanner.popup(for: e, now: now, machineNames: state.machineNames) {
                popup.show(p)
            }
        }
    }

    private func checkForecast(now: Date) {
        guard settings.notificationsEnabled, let spec = forecastWatcher.check(state.limits, now: now) else { return }
        notifier.post(spec)
    }

    // MARK: panel

    func panelAppeared() {
        panelVisible = true
        state.acknowledgeDone()
        popup.dismissAll()
    }

    func panelDisappeared() {
        panelVisible = false
        showSettings = false
    }

    func openPanel() {
        popup.dismissAll()
        if !panelVisible { panelOpener?() }
    }

    /// Ilova ichidagi "Commander" oynasi (WKWebView). Dock ikonkasi oyna ochiq paytda ko'rinadi.
    func openDashboard(_ target: DashboardTarget = .overview) {
        popup.dismissAll()
        panelCloser?()
        dashboardWindow.show(target)
    }

    /// Ikkilamchi: tizim brauzerida.
    func openDashboardInBrowser() {
        NSWorkspace.shared.open(settings.dashboardURL)
    }

    // MARK: approvals

    func actions(for a: ApprovalDto) -> ApprovalActions {
        ApprovalActions.compute(a, canApprove: state.canApprove, lockdown: state.lockdown)
    }

    func phase(_ id: String) -> ApprovalCardPhase { flow.phase(id) }
    func tapAllow(_ id: String) { flow.tapAllow(id) }
    func cancelPhase(_ id: String) { flow.cancel(id) }
    func startFeedback(_ id: String) { flow.startFeedback(id) }
    func editFeedback(_ id: String, _ text: String) { flow.editFeedback(id, text) }

    /// Panel: `allow` faqat inline tasdiqdan keyin (ApprovalFlow.begin ikki bosqichli).
    func decide(_ a: ApprovalDto, behavior: ApprovalBehavior, message: String? = nil) async {
        guard let body = flow.begin(a.id, behavior: behavior, message: message, actions: actions(for: a)) else { return }
        await submit(a, body: body)
    }

    /// Savolga javob (variant indeksi bo'yicha).
    func answer(_ a: ApprovalDto, optionIndex: Int) async {
        guard let body = flow.beginAnswer(a.id, approval: a, optionIndex: optionIndex, canApprove: state.canApprove, lockdown: state.lockdown) else { return }
        await submit(a, body: body)
    }

    /// Bildirishnoma: "Ruxsat" tugmasi `authenticationRequired` (qurilma qulfdan chiqarilgan) — bu tasdiq.
    private func decideFromNotification(id: String, choice: Notifier.ApprovalBehaviorChoice) async {
        guard let a = state.pendingApprovals[id] else {
            notifier.post(NotificationSpec(id: "approval-result-\(id)", category: .done, title: "Ruxsat so'rovi", body: "Allaqachon hal qilingan"))
            return
        }
        // Savolga bildirishnomadan faqat rad etish mumkin (allow javoblarsiz markazda 422).
        if a.kind == .question, choice == .allow { return }
        let behavior: ApprovalBehavior = choice == .allow ? .allow : .deny
        guard let body = flow.begin(id, behavior: behavior, message: nil, actions: actions(for: a), requireConfirm: false) else {
            if let m = actions(for: a).allowDisabledReason {
                notifier.post(NotificationSpec(id: "approval-result-\(id)", category: .done, title: "Ruxsat berilmadi", body: m))
            }
            return
        }
        await submit(a, body: body)
        if case .error(let m) = flow.phase(id) {
            notifier.post(NotificationSpec(id: "approval-result-\(id)", category: .done, title: "\(ApprovalText.project(a)): qaror", body: m))
        }
    }

    private func submit(_ a: ApprovalDto, body: ApprovalDecisionBody) async {
        guard let api else { flow.finish(a.id, outcome: .unauthorized); return }
        let outcome = await api.decide(approvalId: a.id, body: body)
        flow.finish(a.id, outcome: outcome)
        switch outcome {
        case .accepted(let updated, _):
            dispatch(state.upsertApproval(updated))
            if let m = outcome.message { fade(a, m) }
        case .alreadyResolved, .expired, .notFound:
            state.dropApproval(id: a.id)
            notifier.remove(id: "approval-\(a.id)")
            popup.dismiss(approvalId: a.id)
            fade(a, outcome.message ?? "")
            flow.forget(a.id)
        case .lockdown:
            // 403 lockdown: WS `lockdown.updated` kelishini kutmasdan UI'ni moslaymiz.
            dispatch(state.markLockdown(true))
        case .unauthorized:
            socket.disconnect()
            connection = .unauthorized(reason: "Token yaroqsiz: qayta ulang")
        default:
            break
        }
    }

    private func fade(_ a: ApprovalDto, _ message: String) {
        fading[a.id] = (a, message)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            self?.fading.removeValue(forKey: a.id)
        }
    }

    // MARK: pairing

    func handleOpenURL(_ url: URL) {
        guard url.scheme == "commander" else { return }
        switch PairingRequest.fromLink(url.absoluteString) {
        case .success(let req): pairingWindow.show(prefill: req)
        case .failure: pairingWindow.show(prefill: nil, error: PairingRequest.ParseError.invalidLink.message)
        }
    }

    func showPairing() { pairingWindow.show(prefill: nil) }

    /// `POST /v1/clients/pair` -> token Keychain'ga. Muvaffaqiyatsizlikda xabar qaytaradi.
    func pair(_ req: PairingRequest) async -> String? {
        let result = await CenterAPI.pair(req, deviceName: DeviceInfo.name)
        switch result {
        case .failure(let f):
            return f.message
        case .success(let ok):
            socket.disconnect()
            reconnectTask?.cancel()
            guard TokenStore.save(ok.token) else { return "Tokenni Keychain'ga saqlab bo'lmadi" }
            token = ok.token
            settings.centerURL = req.centerURL
            settings.deviceId = ok.deviceId
            state = DashboardState()
            state.scopes = Set(ok.scopes.map(\.rawValue))
            me = nil
            reconnect.connected()
            connect()
            return nil
        }
    }

    /// Unpair: markazda revoke (best effort) + Keychain'dan o'chirish.
    func unpair() async -> String? {
        var warning: String?
        if let api {
            do { try await api.revokeSelf() } catch .unauthorized {
                // allaqachon revoke qilingan
            } catch {
                warning = "Markazga yetib bo'lmadi (\(error.message)). Token lokal o'chirildi; markazda `commander-admin.sh` bilan revoke qiling."
            }
        }
        socket.disconnect()
        reconnectTask?.cancel()
        TokenStore.delete()
        token = nil
        settings.deviceId = nil
        state = DashboardState()
        me = nil
        flow = ApprovalFlow()
        connection = .unpaired
        notifier.removeAll()
        popup.dismissAll()
        return warning
    }

    // MARK: sinov

    func demoPopup(_ pose: MascotPose) {
        let spec: PopupSpec
        switch pose {
        case .ruxsat: spec = PopupSpec(pose: .ruxsat, light: .orange, title: "Sinov: ruxsat so'rovi", text: "srv-01 · Bash: npm test", autoHide: 8, approvalId: nil)
        case .kutmoqda: spec = PopupSpec(pose: .kutmoqda, light: .yellow, title: "Sinov: javob kutmoqda", text: "mac-mini: \"Qaysi branch?\"", autoHide: 8, approvalId: nil)
        default: spec = PopupSpec(pose: .tugatdi, light: .green, title: "Sinov: ishini tugatdi", text: "mac-mini", autoHide: 8, approvalId: nil)
        }
        popup.show(spec)
    }
}
