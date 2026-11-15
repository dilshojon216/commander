import AppKit
import Foundation
import LocalAuthentication
import MenuBarCore
import Security
import WebKit

/// Dashboard ilova siri: FAQAT Keychain'da (fayl/log/UserDefaults'ga yozilmaydi). Sahifaga HECH QACHON berilmaydi.
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`: qulflangan Mac'da o'qilmaydi, zaxiraga/boshqa qurilmaga ko'chmaydi.
/// (Ad-hoc imzoda Data Protection keychain yo'q (-34018): login keychain'ga qaytiladi; element faqat shu ilova yaratgani
/// uchun boshqa ilova o'qisa tizim parol so'raydi.)
enum AppSecretStore {
    static let service = "uz.commander.menubar"
    static let account = "dashboard-app-secret"

    private static func base(dataProtection: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if dataProtection { q[kSecUseDataProtectionKeychain as String] = true }
        return q
    }

    static func save(_ secret: String) -> Bool {
        delete()
        for dp in [true, false] {
            var q = base(dataProtection: dp)
            q[kSecValueData as String] = Data(secret.utf8)
            q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            q[kSecAttrLabel as String] = "Commander dashboard app secret"
            let status = SecItemAdd(q as CFDictionary, nil)
            if status == errSecSuccess { return true }
            log.error("app secret keychain add failed dp=\(dp, privacy: .public) status=\(status, privacy: .public)")
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
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, let s = String(data: d, encoding: .utf8) { return s }
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

/// Touch ID / tizim paroli. Hech qanday usul yo'q bo'lsa (parolsiz Mac) FAIL-CLOSED: tasdiq berilmaydi.
enum OwnerPresence {
    enum Outcome { case ok, cancelled, unavailable }

    static func verify(reason: String) async -> Outcome {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Bekor qilish"
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            log.error("LocalAuthentication unavailable code=\(err?.code ?? 0, privacy: .public)")
            return .unavailable
        }
        do {
            return try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? .ok : .cancelled
        } catch let e as LAError {
            switch e.code {
            case .userCancel, .appCancel, .systemCancel, .userFallback: return .cancelled
            default: return .unavailable
            }
        } catch {
            return .unavailable
        }
    }
}

/// Sahifa <-> ilova ko'prigi (`window.webkit.messageHandlers.commanderAuth.postMessage({action})`, javobli).
/// Xavfsizlik: faqat dashboard origin'idagi ASOSIY freymdan; xabar qat'iy tekshiriladi (`DashboardAuthMessage`); har amal
/// oldidan Touch ID/parol; bir vaqtda bitta so'rov; sir hech qachon sahifaga qaytmaydi.
@MainActor
final class DashboardAuthBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "commanderAuth"
    private let settings: AppSettings
    private var busy = false

    init(settings: AppSettings) {
        self.settings = settings
    }

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpCookieAcceptPolicy = .never
        cfg.httpShouldSetCookies = false
        cfg.timeoutIntervalForRequest = 10
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        let base = settings.dashboardURL
        guard DashboardAuthTrust.isTrusted(origin: message.frameInfo.request.url, isMainFrame: message.frameInfo.isMainFrame, base: base) else {
            log.notice("dashboard auth bridge: untrusted frame")
            return (DashboardAuthReply.failure("untrusted"), nil)
        }
        guard let action = DashboardAuthMessage.parse(message.body) else { return (DashboardAuthReply.failure("invalid_message"), nil) }
        if case .status = action { return (DashboardAuthReply.status(paired: AppSecretStore.load() != nil), nil) }
        guard !busy else { return (DashboardAuthReply.failure("busy"), nil) }
        busy = true
        defer { busy = false }
        let store = message.webView?.configuration.websiteDataStore.httpCookieStore
        switch action {
        case .status: return (DashboardAuthReply.status(paired: AppSecretStore.load() != nil), nil)
        case .pair(let code): return (await pair(code: code, base: base, cookies: store), nil)
        case .login: return (await login(base: base, cookies: store), nil)
        case .elevate: return (await elevate(base: base), nil)
        }
    }

    // MARK: amallar

    private func pair(code: String, base: URL, cookies: WKHTTPCookieStore?) async -> [String: Any] {
        switch await OwnerPresence.verify(reason: "Commander dashboard'ini shu ilova bilan juftlash") {
        case .ok: break
        case .cancelled: return DashboardAuthReply.failure("cancelled")
        case .unavailable: return DashboardAuthReply.failure("no_owner_authentication")
        }
        guard let (data, resp) = await send(DashboardAuthRequests.pair(base: base, setupCode: code, deviceName: DeviceInfo.name)) else { return DashboardAuthReply.failure("dashboard_unreachable") }
        guard resp.statusCode == 200, let secret = DashboardAuthResponse.secret(data) else {
            return DashboardAuthReply.failure(DashboardAuthResponse.errorCode(data) ?? "pair_failed")
        }
        guard AppSecretStore.save(secret) else { return DashboardAuthReply.failure("keychain_failed") }
        return await establishSession(secret: secret, base: base, cookies: cookies)
    }

    private func login(base: URL, cookies: WKHTTPCookieStore?) async -> [String: Any] {
        guard let secret = AppSecretStore.load() else { return DashboardAuthReply.failure("not_paired") }
        switch await OwnerPresence.verify(reason: "Commander dashboard'iga kirish") {
        case .ok: return await establishSession(secret: secret, base: base, cookies: cookies)
        case .cancelled: return DashboardAuthReply.failure("cancelled")
        case .unavailable: return DashboardAuthReply.failure("no_owner_authentication")
        }
    }

    private func elevate(base: URL) async -> [String: Any] {
        guard let secret = AppSecretStore.load() else { return DashboardAuthReply.failure("not_paired") }
        switch await OwnerPresence.verify(reason: "Xavfli amalni tasdiqlash (ruxsat berish, buyruq yuborish yoki sozlamani o'zgartirish)") {
        case .ok: break
        case .cancelled: return DashboardAuthReply.failure("cancelled")
        case .unavailable: return DashboardAuthReply.failure("no_owner_authentication")
        }
        guard let (data, resp) = await send(DashboardAuthRequests.elevationToken(base: base, secret: secret)) else { return DashboardAuthReply.failure("dashboard_unreachable") }
        guard resp.statusCode == 200, let token = DashboardAuthResponse.token(data) else {
            return DashboardAuthReply.failure(DashboardAuthResponse.errorCode(data) ?? "elevate_failed")
        }
        return DashboardAuthReply.token(token)
    }

    /// Sir bilan sessiya oladi va cookie'ni WKWebView'ning cookie omboriga yozadi.
    private func establishSession(secret: String, base: URL, cookies: WKHTTPCookieStore?) async -> [String: Any] {
        guard let (data, resp) = await send(DashboardAuthRequests.login(base: base, secret: secret)) else { return DashboardAuthReply.failure("dashboard_unreachable") }
        guard resp.statusCode == 200, let cookie = DashboardAuthResponse.sessionCookie(from: resp, url: base) else {
            return DashboardAuthReply.failure(DashboardAuthResponse.errorCode(data) ?? "login_failed")
        }
        guard let cookies else { return DashboardAuthReply.failure("no_cookie_store") }
        await cookies.setCookie(cookie)
        return DashboardAuthReply.ok()
    }

    private func send(_ request: URLRequest) async -> (Data, HTTPURLResponse)? {
        do {
            let (data, resp) = try await session.data(for: request)
            guard let http = resp as? HTTPURLResponse else { return nil }
            return (data, http)
        } catch {
            log.error("dashboard auth request failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }
}
