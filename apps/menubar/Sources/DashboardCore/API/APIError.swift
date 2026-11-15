import Foundation

/// Markaz bilan muloqot xatosi. HTTP holati va markaz `{error}` kodidan hosil bo'ladi; foydalanuvchi matni `ErrorText`da.
public enum APIError: Error, Equatable, Sendable {
    /// 401: token yaroqsiz yoki bekor qilingan (qayta juftlash kerak).
    case unauthorized
    /// 403 `lockdown`: masofaviy amallar bloklangan.
    case lockdown
    /// 403 `insufficient_scope`: token ruxsati yetarli emas (masalan `control` yo'q).
    case insufficientScope
    /// Boshqa 403 (masalan mashina siyosati); `code` markaz kodi.
    case forbidden(code: String?)
    case notFound
    /// 409: holat o'zgargan yoki idempotentlik to'qnashuvi; `status` — javob tanasidagi obyekt holati (masalan ruxsat so'rovi `expired`).
    case conflict(code: String?, status: String?)
    /// 400/413/422: so'rov ma'lumoti noto'g'ri.
    case validation(code: String?)
    case rateLimited(retryAfter: TimeInterval?)
    /// 5xx.
    case server(status: Int)
    /// Qolgan HTTP holatlari.
    case http(status: Int, code: String?)
    /// Tarmoq yo'q yoki markazga yetib bo'lmadi.
    case offline
    /// Javobni kutilgan tipga o'qib bo'lmadi (tip nomi).
    case decoding(String)
    /// So'rovni tuzib bo'lmadi (URL yoki tana).
    case invalidRequest(String)
    /// Token Keychain'da yo'q.
    case noToken

    /// HTTP javobini xatoga aylantiradi (2xx uchun chaqirilmaydi).
    public static func from(status: Int, code: String?, retryAfter: TimeInterval? = nil, bodyStatus: String? = nil) -> APIError {
        switch status {
        case 401: return .unauthorized
        case 403:
            switch code {
            case "lockdown": return .lockdown
            case "insufficient_scope": return .insufficientScope
            default: return .forbidden(code: code)
            }
        case 404: return .notFound
        case 409: return .conflict(code: code, status: bodyStatus)
        case 400, 413, 422: return .validation(code: code)
        case 429: return .rateLimited(retryAfter: retryAfter)
        case 500...599: return .server(status: status)
        default: return .http(status: status, code: code)
        }
    }
}
