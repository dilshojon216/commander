import AppKit
import DashboardCore
import MenuBarCore
import SwiftUI

/// Sof AppKit hayot sikli: SwiftUI `App` sahnasi (hatto bo'sh `Settings`) ishga tushishda o'z oynasini ochib qo'yardi.
/// Menu-bar ikonkasi va panel `StatusPanelController`da, sozlamalar panel ichida.
@main
enum CommanderMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    let model = AppModel()
    private var statusPanel: StatusPanelController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if PreviewRenderer.runIfRequested() { exit(0) }
        // LSUIElement `.app` da Info.plist orqali; `swift run` uchun ham Dock ikonkasiz.
        NSApp.setActivationPolicy(.accessory)
        let panel = StatusPanelController(model: model)
        statusPanel = panel
        model.panelOpener = { [weak panel] in panel?.show() }
        model.panelCloser = { [weak panel] in panel?.close() }
        NSApp.mainMenu = makeMainMenu()
        model.start()
        // Tutun sinovi: dashboard oynasini ham ochib ko'rish.
        if ProcessInfo.processInfo.environment["COMMANDER_MENUBAR_OPEN_DASHBOARD"] == "1" { model.openDashboard() }
    }

    /// Dock ikonkasi bosilishi (yoki ishlab turgan ilovani qayta `open` qilish): dashboard oynasi.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        model.openDashboard()
        return false
    }

    /// Asosiy menyu (dashboard oynasi ochiqligida ko'rinadi): Sozlamalar panelda ochiladi.
    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Commander")
        appMenu.addItem(withTitle: "Commander haqida", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let settingsItem = NSMenuItem(title: "Sozlamalar…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Yashirish", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Chiqish", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Tahrir")
        edit.addItem(withTitle: "Bekor qilish", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Qaytarish", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Kesish", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Nusxalash", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Qo'yish", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Hammasini tanlash", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        main.addItem(makeViewMenuItem())

        let windowItem = NSMenuItem()
        let window = NSMenu(title: "Oyna")
        window.addItem(withTitle: "Kichraytirish", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Yopish", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = window
        main.addItem(windowItem)
        NSApp.windowsMenu = window
        return main
    }

    /// "Ko'rinish" menyusi: bo'limlar (⌘1...⌘9), tarix (⌘[ ⌘]), yangilash (⌘R), qidiruv (⌘F). Faqat native oyna faol bo'lganda yoqiq.
    private func makeViewMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Ko'rinish")
        for section in SidebarSection.allCases {
            guard let digit = section.shortcutDigit else { continue }
            let entry = NSMenuItem(title: section.title, action: #selector(openSection(_:)), keyEquivalent: String(digit))
            entry.tag = digit
            entry.target = self
            menu.addItem(entry)
        }
        menu.addItem(.separator())
        menu.addItem(viewItem("Orqaga", #selector(navigateBack), "["))
        menu.addItem(viewItem("Oldinga", #selector(navigateForward), "]"))
        menu.addItem(.separator())
        menu.addItem(viewItem("Yangilash", #selector(refreshDashboard), "r"))
        menu.addItem(viewItem("Qidirish", #selector(openSearch), "f"))
        item.submenu = menu
        return item
    }

    private func viewItem(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        return entry
    }

    @objc private func openSection(_ sender: NSMenuItem) {
        guard let section = SidebarSection.forShortcut(digit: sender.tag) else { return }
        model.nativeDashboard.navigation.select(section)
    }

    @objc private func navigateBack() { model.nativeDashboard.navigation.goBack() }
    @objc private func navigateForward() { model.nativeDashboard.navigation.goForward() }
    @objc private func refreshDashboard() { model.refresh() }
    @objc private func openSearch() { model.nativeDashboard.navigation.select(.search) }

    /// Ko'rinish menyusi faqat native oyna kalit oyna bo'lganda ishlaydi (web oynasi o'z yorliqlarini o'zi boshqaradi).
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        let viewActions: [Selector] = [#selector(openSection(_:)), #selector(navigateBack), #selector(navigateForward), #selector(refreshDashboard), #selector(openSearch)]
        guard let action = menuItem.action, viewActions.contains(action) else { return true }
        guard model.nativeDashboard.isKey else { return false }
        if action == #selector(navigateBack) { return model.nativeDashboard.navigation.canGoBack }
        if action == #selector(navigateForward) { return model.nativeDashboard.navigation.canGoForward }
        return true
    }

    @objc private func openSettings() {
        model.showSettings = true
        model.openPanel()
    }

    /// Oldingi ishga tushishdagi oynalar (masalan Sozlamalar) qayta tiklanmaydi.
    func applicationShouldSaveApplicationState(_ app: NSApplication) -> Bool { false }
    func applicationShouldRestoreApplicationState(_ app: NSApplication) -> Bool { false }

    /// Oxirgi oyna yopilsa ilova yopilmaydi (menu-bar ilovasi).
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// `commander://pair?...` havolasi (CFBundleURLTypes).
    func application(_ application: NSApplication, open urls: [URL]) {
        if !(urls.isEmpty) { model.start() }
        for url in urls { model.handleOpenURL(url) }
    }
}
