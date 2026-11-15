import AppKit
import MenuBarCore
import SwiftUI

@main
struct CommanderApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: delegate.model)
        } label: {
            MenuBarLabel(model: delegate.model)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if PreviewRenderer.runIfRequested() { exit(0) }
        // LSUIElement `.app` da Info.plist orqali; `swift run` uchun ham Dock ikonkasiz.
        NSApp.setActivationPolicy(.accessory)
        model.start()
        // Tutun sinovi: dashboard oynasini ham ochib ko'rish.
        if ProcessInfo.processInfo.environment["COMMANDER_MENUBAR_OPEN_DASHBOARD"] == "1" { model.openDashboard() }
    }

    /// Dock ikonkasi bosilishi (yoki ishlab turgan ilovani qayta `open` qilish): dashboard oynasi.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        model.openDashboard()
        return false
    }

    /// Oxirgi oyna yopilsa ilova yopilmaydi (menu-bar ilovasi).
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// `commander://pair?...` havolasi (CFBundleURLTypes).
    func application(_ application: NSApplication, open urls: [URL]) {
        if !(urls.isEmpty) { model.start() }
        for url in urls { model.handleOpenURL(url) }
    }
}

/// Menu-bar: maskot boshi (soddalashtirilgan) + ixcham matn. Diqqat kerak bo'lsa rangli chiroq.
struct MenuBarLabel: View {
    let model: AppModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let mood = model.mood
        let summary = model.summary
        let text = model.menuText
        HStack(spacing: 4) {
            Image(nsImage: MascotGlyphRenderer.image(light: mood.light, attention: mood.needsAttention || mood.light != .gray, dark: scheme == .dark))
            if !text.isEmpty { Text(text).monospacedDigit() }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MenuText.accessibilityLabel(summary: summary, limits: model.state.limits, connection: model.connection))
    }
}
