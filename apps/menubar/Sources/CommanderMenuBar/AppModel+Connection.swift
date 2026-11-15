import AppKit
import CommanderContracts
import DashboardCore
import Foundation
import MenuBarCore
import SwiftUI

/// Ulanish (LiveHub), snapshot va hodisalarni bildirishnoma/maskotga yo'naltirish.
extension AppModel {
    // MARK: ulanish

    func connect() {
        guard let token, let center = settings.centerURL, let ws = CenterURLs.webSocket(center: center) else {
            connection = .unpaired
            return
        }
        connection = .connecting
        ensureLiveLoop()
        Task { await hub.start(url: ws, token: token) }
    }

    /// "Qayta ulash" tugmasi: backoff'ni kutmasdan.
    func reconnectNow() {
        Task { await hub.reconnectNow() }
    }

    /// Hub hodisalariga BIR marta obuna bo'ladi (ulanish almashsa ham oqim saqlanadi).
    func ensureLiveLoop() {
        guard liveTask == nil else { return }
        liveTask = Task { [weak self, hub] in
            let stream = await hub.events(channels: Set(ClientWire.channels))
            for await event in stream {
                guard let self else { return }
                self.handle(event)
            }
        }
    }

    func handle(_ event: LiveEvent) {
        switch event {
        case .status(.unpaired):
            break // "ulanmagan" holatini AppModel o'zi boshqaradi (token yo'q)
        case .status(let status):
            DebugLog.write("live status \(status)")
            connection = status
        case .resync:
            DebugLog.write("live resync -> snapshot")
            // PLAN §8: avval subscribe, KEYIN REST snapshot.
            Task { await loadSnapshot() }
        case .message(let msg):
            dispatch(state.apply(msg))
            if case .limitsUpdated = msg { checkForecast(now: Date()) }
        }
    }

    func loadSnapshot() async {
        guard let service else { return }
        do {
            let snap = try await service.snapshot()
            DebugLog.write("snapshot ok sessions=\(snap.sessions.count) machines=\(snap.machines.count) approvals=\(snap.pendingApprovals.count)")
            dispatch(state.applySnapshot(snap))
            lastError = nil
            checkForecast(now: Date())
            if let m = try? await service.me() {
                me = m
                state.scopes = Set(m.scopes.map(\.rawValue))
            }
        } catch .unauthorized {
            await hub.stop()
            connection = .unauthorized(reason: "Token yaroqsiz yoki bekor qilingan: qayta ulang")
        } catch {
            DebugLog.write("snapshot failed \(error)")
            lastError = ErrorText.message(for: error)
        }
    }

    var service: CenterService? {
        guard let token, let center = settings.centerURL else { return nil }
        let client = CenterHTTPClient(center: center, transport: URLSession.shared, tokens: StaticTokenProvider(token))
        return CenterService(client: client)
    }

    // MARK: hodisalar -> bildirishnoma / maskot

    func dispatch(_ events: [DashboardEvent]) {
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

    func checkForecast(now: Date) {
        guard settings.notificationsEnabled, let spec = forecastWatcher.check(state.limits, now: now) else { return }
        notifier.post(spec)
    }
}
