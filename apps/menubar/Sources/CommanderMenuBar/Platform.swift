import AppKit
import MenuBarCore
import os
import Security
import ServiceManagement
import SwiftUI

let log = Logger(subsystem: "uz.commander.menubar", category: "app")

/// Diagnostika: `defaults write uz.commander.menubar debugLog -bool YES` bo'lsa ~/Library/Logs/commander/menubar-debug.log ga yoziladi.
/// Faqat oyna/hodisa holati yoziladi: token, prompt matni va sahifa mazmuni yozilmaydi (yo'l faqat path qismi).
enum DebugLog {
    static let enabled = UserDefaults.standard.bool(forKey: "debugLog")
    private static let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/commander/menubar-debug.log")
    private static let queue = DispatchQueue(label: "uz.commander.menubar.debuglog")

    static func write(_ message: @autoclosure () -> String) {
        guard enabled else { return }
        let line = "\(Date().formatted(.iso8601.time(includingFractionalSeconds: true))) \(message())\n"
        queue.async {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let h = try? FileHandle(forWritingTo: url) {
                h.seekToEndOfFile()
                h.write(Data(line.utf8))
                try? h.close()
            } else {
                try? line.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }

    @MainActor static func windowState() -> String {
        let key = NSApp.keyWindow.map { "\(type(of: $0))#\($0.windowNumber)" } ?? "nil"
        let wins = NSApp.windows.filter(\.isVisible).map { "\(type(of: $0))#\($0.windowNumber)@\($0.level.rawValue)" }.joined(separator: ",")
        return "active=\(NSApp.isActive) key=\(key) visible=[\(wins)]"
    }
}

/// Client token FAQAT Keychain'da (CLAUDE.md #5; fayl/log/UserDefaults'ga yozilmaydi).
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: boshqa qurilmaga/zaxiraga ko'chmaydi.
/// Avval Data Protection keychain; ad-hoc imzoda entitlement yo'qligi sababli (-34018) login keychain'ga qaytadi.
enum TokenStore {
    static let service = "uz.commander.menubar"
    static let account = "client-token"

    private static func base(dataProtection: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if dataProtection { q[kSecUseDataProtectionKeychain as String] = true }
        return q
    }

    static func save(_ token: String) -> Bool {
        delete()
        let data = Data(token.utf8)
        for dp in [true, false] {
            var q = base(dataProtection: dp)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            q[kSecAttrLabel as String] = "Commander menu-bar client token"
            let status = SecItemAdd(q as CFDictionary, nil)
            if status == errSecSuccess { return true }
            log.error("keychain add failed dp=\(dp, privacy: .public) status=\(status, privacy: .public)")
            if status != errSecMissingEntitlement { return false }
        }
        return false
    }

    static func load() -> String? {
        for dp in [true, false] {
            var q = base(dataProtection: dp)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, let s = String(data: d, encoding: .utf8) {
                return s
            }
        }
        return nil
    }

    @discardableResult
    static func delete() -> Bool {
        var ok = true
        for dp in [true, false] {
            let st = SecItemDelete(base(dataProtection: dp) as CFDictionary)
            if st != errSecSuccess && st != errSecItemNotFound && st != errSecMissingEntitlement { ok = false }
        }
        return ok
    }
}

/// Maxfiy bo'lmagan sozlamalar (UserDefaults). Token bu yerda EMAS.
@MainActor @Observable
final class AppSettings {
    private let d = UserDefaults.standard

    var centerURL: URL? { didSet { d.set(centerURL?.absoluteString, forKey: "centerURL") } }
    var deviceId: String? { didSet { d.set(deviceId, forKey: "deviceId") } }
    var textFormat: MenuTextFormat { didSet { d.set(textFormat.rawValue, forKey: "textFormat") } }
    var limitWindow: LimitWindowChoice { didSet { d.set(limitWindow.rawValue, forKey: "limitWindow") } }
    var notificationsEnabled: Bool { didSet { d.set(notificationsEnabled, forKey: "notificationsEnabled") } }
    var mascotPopupsEnabled: Bool { didSet { d.set(mascotPopupsEnabled, forKey: "mascotPopupsEnabled") } }
    /// Dashboard oynasi/brauzer manzili (sukut `http://127.0.0.1:4318`; dashboard faqat lokal).
    var dashboardURL: URL { didSet { d.set(dashboardURL.absoluteString, forKey: "dashboardURL") } }

    init() {
        centerURL = d.string(forKey: "centerURL").flatMap(URL.init(string:))
        deviceId = d.string(forKey: "deviceId")
        textFormat = d.string(forKey: "textFormat").flatMap(MenuTextFormat.init(rawValue:)) ?? .full
        limitWindow = d.string(forKey: "limitWindow").flatMap(LimitWindowChoice.init(rawValue:)) ?? .sevenDay
        notificationsEnabled = d.object(forKey: "notificationsEnabled") as? Bool ?? true
        mascotPopupsEnabled = d.object(forKey: "mascotPopupsEnabled") as? Bool ?? true
        dashboardURL = d.string(forKey: "dashboardURL").flatMap(DashboardBaseURL.parse) ?? DashboardBaseURL.default
    }
}

/// Login'da ishga tushirish (SMAppService; faqat `.app` ichidan ishlaydi).
@MainActor
enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) -> String? {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            return "Login elementini o'zgartirib bo'lmadi: \(error.localizedDescription)"
        }
    }
}

enum DeviceInfo {
    @MainActor static var name: String { Host.current().localizedName ?? "Mac" }
    static var isBundled: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }
}
