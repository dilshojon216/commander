import Foundation

/// H-01 (TASKS 5.6): dashboard lokal autentifikatsiyasi, Mac ilova tomoni (sof mantiq; testlanadi).
///
/// Oqim: ilova o'zining tasodifiy siri (juftlashda dashboard beradi) ni Keychain'da saqlaydi. Oyna ochilganda yoki xavfli amal
/// oldidan LocalAuthentication (Touch ID/parol) so'raladi, shundan keyingina sir bilan dashboard'ga murojaat qilinadi.
/// Sir sahifaga HECH QACHON berilmaydi: sahifa faqat `{ok}` / bir martalik 30 soniyalik elevation tokenini oladi.

/// Sahifa (WKScriptMessageHandlerWithReply "commanderAuth") yuboradigan xabar turlari.
public enum DashboardAuthAction: Equatable, Sendable {
    case status
    case pair(setupCode: String)
    case login
    case elevate
}

public enum DashboardAuthMessage {
    /// Sozlash kodi: 8 belgi, 32 harfli alifbo (0/O/1/I yo'q); `ABCD-EFGH` yoki `abcdefgh`.
    static let alphabet = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

    public static func normalizeSetupCode(_ raw: String) -> String {
        String(raw.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) })
    }

    public static func isWellFormedSetupCode(_ raw: String) -> Bool {
        let n = normalizeSetupCode(raw)
        return n.count == 8 && n.allSatisfy { alphabet.contains($0) }
    }

    /// Sahifa xabarini qat'iy tekshiradi: noma'lum `action`, noto'g'ri kod yoki ortiqcha tur -> nil.
    public static func parse(_ body: Any) -> DashboardAuthAction? {
        guard let d = body as? [String: Any], let action = d["action"] as? String else { return nil }
        switch action {
        case "status": return .status
        case "login": return .login
        case "elevate": return .elevate
        case "pair":
            guard let code = d["setupCode"] as? String, code.count <= 32, isWellFormedSetupCode(code) else { return nil }
            return .pair(setupCode: normalizeSetupCode(code))
        default: return nil
        }
    }
}

/// Dashboard auth so'rovlarini quradi (URLSession bilan ilova yuboradi; Origin sarlavhasi yo'q, shuning uchun dashboard
/// ularni "ilova yo'li" sifatida qabul qiladi va faqat sir/kod bilan ishlaydi).
public enum DashboardAuthRequests {
    static func url(_ base: URL, _ path: String) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false) ?? URLComponents()
        c.path = path
        c.query = nil
        c.fragment = nil
        return c.url ?? base
    }

    static func post(_ url: URL, bearer: String? = nil, json: [String: String] = [:]) -> URLRequest {
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer { r.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        r.httpBody = try? JSONSerialization.data(withJSONObject: json)
        r.httpShouldHandleCookies = false
        return r
    }

    public static func pair(base: URL, setupCode: String, deviceName: String) -> URLRequest {
        post(url(base, "/api/auth/app/pair"), json: ["setupCode": setupCode, "name": String(deviceName.prefix(60))])
    }

    public static func login(base: URL, secret: String) -> URLRequest {
        post(url(base, "/api/auth/app/login"), bearer: secret)
    }

    public static func elevationToken(base: URL, secret: String) -> URLRequest {
        post(url(base, "/api/auth/app/elevation-token"), bearer: secret)
    }
}

/// Dashboard javoblarini o'qiydi.
public enum DashboardAuthResponse {
    public static func string(_ key: String, in data: Data) -> String? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return o[key] as? String
    }

    /// `{ok:true, secret}` -> sir (juftlash). Faqat shu yerda va Keychain'da.
    public static func secret(_ data: Data) -> String? {
        guard let s = string("secret", in: data), s.count >= 32, s.count <= 256 else { return nil }
        return s
    }

    /// `{ok:true, token}` -> bir martalik elevation tokeni.
    public static func token(_ data: Data) -> String? {
        guard let s = string("token", in: data), s.count >= 16, s.count <= 256 else { return nil }
        return s
    }

    public static func errorCode(_ data: Data) -> String? { string("error", in: data) }

    /// Sessiya cookie'si (`commander_session`): faqat shu nomdagi va dashboard host'i uchun.
    public static func sessionCookie(from response: HTTPURLResponse, url: URL) -> HTTPCookie? {
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { acc, kv in
            if let k = kv.key as? String, let v = kv.value as? String { acc[k] = v }
        }
        return HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).first { $0.name == "commander_session" && !$0.value.isEmpty }
    }
}

/// Mac ilova ko'prigiga ishonish: faqat dashboard origin'idagi ASOSIY freymdan (iframe va begona sahifa emas).
public enum DashboardAuthTrust {
    public static func isTrusted(origin url: URL?, isMainFrame: Bool, base: URL) -> Bool {
        guard isMainFrame, let url else { return false }
        return DashboardNavigationPolicy.isInternal(url, base: base)
    }
}

/// Sahifaga qaytariladigan javob (`WKScriptMessageHandlerWithReply`): sirni HECH QACHON o'z ichiga olmaydi.
public enum DashboardAuthReply {
    public static func status(paired: Bool) -> [String: Any] { ["available": true, "paired": paired] }
    public static func ok() -> [String: Any] { ["ok": true] }
    public static func token(_ t: String) -> [String: Any] { ["ok": true, "token": t] }
    public static func failure(_ code: String) -> [String: Any] { ["ok": false, "error": code] }
}
