import AppKit
import CommanderContracts
import DashboardCore
import Foundation
import MenuBarCore
import SwiftUI

/// Juftlash/unpair va namoyish (demo) yordamchilari.
extension AppModel {
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
        let result = await PairingClient.pair(req, deviceName: DeviceInfo.name, transport: URLSession.shared)
        switch result {
        case .failure(let f):
            return f.message
        case .success(let ok):
            await hub.stop()
            guard TokenStore.save(ok.token) else { return "Tokenni Keychain'ga saqlab bo'lmadi" }
            token = ok.token
            settings.centerURL = req.centerURL
            settings.deviceId = ok.deviceId
            state = DashboardState()
            state.scopes = Set(ok.scopes.map(\.rawValue))
            me = nil
            connect()
            return nil
        }
    }

    /// Unpair: markazda revoke (best effort) + Keychain'dan o'chirish.
    func unpair() async -> String? {
        var warning: String?
        if let service {
            do { try await service.revokeSelf() } catch .unauthorized {
                // allaqachon revoke qilingan
            } catch {
                warning = "Markazga yetib bo'lmadi (\(ErrorText.message(for: error))). Token lokal o'chirildi; markazda `commander-admin.sh` bilan revoke qiling."
            }
        }
        await hub.stop()
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
