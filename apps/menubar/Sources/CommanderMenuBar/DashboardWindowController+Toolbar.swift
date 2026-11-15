import AppKit
import DashboardUI
import MenuBarCore
import SwiftUI
import WebKit

/// Klaviatura yorliqlari, sahifada qidirish (⌘F) va toolbar (DashboardWindow.swift dan ajratilgan).
extension DashboardWindowController {
    // MARK: klaviatura

    func handleKey(_ e: NSEvent) -> Bool {
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command), let key = e.charactersIgnoringModifiers?.lowercased() else { return false }
        let shift = flags.contains(.shift)
        let other = flags.subtracting([.command, .shift, .capsLock, .numericPad, .function])
        guard other.isEmpty else { return false }
        func send(_ sel: String) -> Bool { NSApp.sendAction(Selector(sel), to: nil, from: window) }
        switch (key, shift) {
        case ("r", false): reload(); return true
        case ("[", false): goBack(); return true
        case ("]", false): goForward(); return true
        case ("w", false): window?.performClose(nil); return true
        case ("f", false): focusSearch(); return true
        case ("d", false): return true // oyna allaqachon ochiq
        case ("=", _), ("+", _): webView?.pageZoom = min(3, (webView?.pageZoom ?? 1) + 0.1); return true
        case ("-", false): webView?.pageZoom = max(0.5, (webView?.pageZoom ?? 1) - 0.1); return true
        case ("0", false): webView?.pageZoom = 1; return true
        // Tahrir tugmalari (accessory ilovada asosiy menyu bo'lmasligi mumkin).
        case ("c", false): return send("copy:")
        case ("v", false): return send("paste:")
        case ("x", false): return send("cut:")
        case ("a", false): return send("selectAll:")
        case ("z", false): return send("undo:")
        case ("z", true): return send("redo:")
        default: return false
        }
    }

    // MARK: qidiruv (⌘F)

    func focusSearch() {
        guard let searchField else { return }
        window?.makeFirstResponder(searchField)
        searchField.selectText(nil)
    }

    func find(_ text: String, backwards: Bool) {
        guard !text.isEmpty, let webView else { return }
        let cfg = WKFindConfiguration()
        cfg.backwards = backwards
        cfg.wraps = true
        cfg.caseSensitive = false
        webView.find(text, configuration: cfg) { result in
            if !result.matchFound { NSSound.beep() }
        }
    }

    @objc private func searchChanged(_ sender: NSSearchField) {
        find(sender.stringValue, backwards: false)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard let field = control as? NSSearchField else { return false }
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            let back = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
            find(field.stringValue, backwards: back)
            return true
        }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            field.stringValue = ""
            window?.makeFirstResponder(webView)
            return true
        }
        return false
    }

    // MARK: toolbar

    private static let backID = NSToolbarItem.Identifier("dashboard.back")
    private static let forwardID = NSToolbarItem.Identifier("dashboard.forward")
    private static let reloadID = NSToolbarItem.Identifier("dashboard.reload")
    private static let searchID = NSToolbarItem.Identifier("dashboard.search")

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.backID, Self.forwardID, Self.reloadID, .flexibleSpace, Self.searchID]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        func button(_ symbol: String, _ label: String, _ action: Selector) -> NSToolbarItem {
            let item = NSToolbarItem(itemIdentifier: id)
            item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
            item.label = label
            item.toolTip = label
            item.isBordered = true
            item.target = self
            item.action = action
            item.autovalidates = false
            return item
        }
        switch id {
        case Self.backID:
            let item = button("chevron.left", "Orqaga (⌘[)", #selector(goBack))
            item.isEnabled = webView?.canGoBack ?? false
            backItem = item
            return item
        case Self.forwardID:
            let item = button("chevron.right", "Oldinga (⌘])", #selector(goForward))
            item.isEnabled = webView?.canGoForward ?? false
            forwardItem = item
            return item
        case Self.reloadID:
            return button("arrow.clockwise", "Yangilash (⌘R)", #selector(reload))
        case Self.searchID:
            let item = NSSearchToolbarItem(itemIdentifier: id)
            item.searchField.placeholderString = "Sahifada qidirish (⌘F)"
            item.searchField.delegate = self
            item.searchField.target = self
            item.searchField.action = #selector(searchChanged(_:))
            item.searchField.sendsSearchStringImmediately = false
            item.searchField.sendsWholeSearchString = false
            searchField = item.searchField
            return item
        default:
            return nil
        }
    }

    @objc private func goBack() { webView?.goBack() }
    @objc private func goForward() { webView?.goForward() }
    @objc private func reload() { if failedURL != nil { retry() } else { webView?.reload() } }
}
