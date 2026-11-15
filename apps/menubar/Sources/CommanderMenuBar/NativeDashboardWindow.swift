import AppKit
import DashboardCore
import DashboardUI
import MenuBarCore
import SwiftUI

/// Native dashboard oynasi (SwiftUI `DashboardRootView` `NSHostingController` ichida). Tarix va tanlangan bo'lim `NavigationModel`da.
/// Dock ikonkasi `DockPresence` orqali web oynasi bilan birga boshqariladi.
@MainActor
final class NativeDashboardWindowController: NSObject, NSWindowDelegate {
    static let frameName = "CommanderNativeDashboardWindow"

    let navigation = NavigationModel()
    private let model: AppModel
    private let dock: DockPresence
    private var window: NSWindow?
    private var isOpen = false

    init(model: AppModel, dock: DockPresence) {
        self.model = model
        self.dock = dock
    }

    var isKey: Bool { window?.isKeyWindow == true }

    func show(_ route: Route? = nil) {
        if let route { navigation.navigate(to: route) }
        let w = window ?? makeWindow()
        window = w
        if !isOpen {
            isOpen = true
            dock.windowOpened()
        }
        DebugLog.write("native dash show route=\(navigation.current.path) \(DebugLog.windowState())")
        NSApp.activate()
        w.makeKeyAndOrderFront(nil)
        Task { @MainActor in w.makeKeyAndOrderFront(nil) }
    }

    func windowWillClose(_ notification: Notification) {
        isOpen = false
        dock.windowClosed()
    }

    private func makeWindow() -> NSWindow {
        let host = NSHostingController(rootView: NativeShellHost(model: model, navigation: navigation))
        host.sceneBridgingOptions = [.toolbars, .title]
        let w = NSWindow(contentViewController: host)
        w.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        w.setContentSize(NSSize(width: 1280, height: 820))
        w.minSize = NSSize(width: 720, height: 480)
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.toolbarStyle = .unified
        w.delegate = self
        if !w.setFrameUsingName(Self.frameName) { w.center() }
        w.setFrameAutosaveName(Self.frameName)
        return w
    }
}

/// `AppModel` -> `DashboardRootView` ma'lumotlari. Hali native ekrani yo'q marshrutlar "web ko'rinishda ochish" sahifasini ko'rsatadi.
struct NativeShellHost: View {
    let model: AppModel
    let navigation: NavigationModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            DashboardRootView(
                navigation: navigation,
                counters: SidebarCounters(summary: model.summary),
                limit: SidebarLimitSummary(limits: model.state.limits, now: context.date),
                connection: ConnectionBadge(model.connection),
                lockdown: model.state.lockdown,
                actions: ShellActions(refresh: { model.refresh() }, openInBrowser: { model.openInBrowser(navigation.current) })
            ) { route in
                NativePlaceholderView(
                    route: route,
                    openWebView: { model.openInWebView(route) },
                    openBrowser: { model.openInBrowser(route) }
                )
            }
        }
    }
}
