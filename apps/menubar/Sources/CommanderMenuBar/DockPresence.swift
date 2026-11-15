import AppKit
import MenuBarCore

/// Dock ikonkasi: dashboard oynalaridan biri ochiq bo'lsa `.regular`, hammasi yopilsa `.accessory` (faqat menu-bar).
/// Web va native oynalar BIR xil hisobni baham ko'radi, shuning uchun biri yopilganda ikkinchisining Dock ikonkasi yo'qolmaydi.
@MainActor
final class DockPresence {
    private var state = ActivationPolicyState()

    func windowOpened() { apply(state.windowOpened()) }
    func windowClosed() { apply(state.windowClosed()) }

    private func apply(_ policy: ActivationPolicyState.Policy?) {
        guard let policy else { return }
        switch policy {
        case .regular:
            NSApp.setActivationPolicy(.regular)
            NSApp.applicationIconImage = DockIcon.image
        case .accessory:
            NSApp.setActivationPolicy(.accessory)
        }
    }
}
