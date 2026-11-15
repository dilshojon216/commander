import AppKit
import CommanderContracts
import DashboardCore
import Foundation
import MenuBarCore
import SwiftUI

/// Ruxsat so'rovlari: qaror yuborish, bildirishnomadan qaror, savollarga javob.
extension AppModel {
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
    func decideFromNotification(id: String, choice: Notifier.ApprovalBehaviorChoice) async {
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

    func submit(_ a: ApprovalDto, body: ApprovalDecisionBody) async {
        guard let service else { flow.finish(a.id, outcome: .unauthorized); return }
        let outcome = await service.decide(approvalId: a.id, body: body)
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
            Task { await hub.stop() }
            connection = .unauthorized(reason: "Token yaroqsiz: qayta ulang")
        default:
            break
        }
    }

    func fade(_ a: ApprovalDto, _ message: String) {
        fading[a.id] = (a, message)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            self?.fading.removeValue(forKey: a.id)
        }
    }
}
