import Foundation

/// Xato -> o'zbekcha matn. Buyruq kodlari jadvali web dashboard bilan bir manbadan generatsiya qilinadi
/// (`scripts/gen-error-texts.mjs`); HTTP holati matnlari web `lib/control-ui.ts` / `lib/*-view.ts` bilan bir xil.
public enum ErrorText {
    /// Buyruq xato kodi (`CommandDto.errorCode`) -> matn; noma'lum kod umumiy matn bilan.
    public static func command(code: String?) -> String {
        guard let code, !code.isEmpty else { return "Buyruq bajarilmadi" }
        return GeneratedErrorTexts.commands[code] ?? "Buyruq bajarilmadi (\(code))"
    }

    /// Jadvalda bor kodmi (test va UI tarmoqlanishi uchun).
    public static func hasCommandText(for code: String) -> Bool {
        GeneratedErrorTexts.commands[code] != nil
    }

    public static func message(for error: APIError) -> String {
        switch error {
        case .unauthorized: "Token rad etildi: markaz bilan qayta juftlang"
        case .lockdown: command(code: "lockdown")
        case .insufficientScope: "Boshqaruv uchun token ruxsati yetarli emas"
        case .forbidden(let code): known(code) ?? "Ruxsat yo'q"
        case .notFound: "Topilmadi: ro'yxatni yangilab qayta urinib ko'ring"
        case .conflict(let code, _): known(code) ?? "Bu amalni hozir bajarib bo'lmaydi (holat o'zgargan)"
        case .validation(let code): known(code) ?? "So'rov ma'lumoti noto'g'ri"
        case .rateLimited(let retryAfter): rateLimited(retryAfter)
        case .server(let status): status == 502 || status == 503 || status == 504 ? "Markazga ulanib bo'lmadi" : "Markaz xatosi (\(status))"
        case .http(let status, let code): known(code) ?? "Xatolik (\(status))"
        case .offline: "Markazga yetib bo'lmadi: aloqani tekshiring"
        case .decoding: "Markaz javobini o'qib bo'lmadi"
        case .invalidRequest: "So'rovni tuzib bo'lmadi"
        case .noToken: "Token topilmadi: markaz bilan qayta juftlang"
        }
    }

    private static func known(_ code: String?) -> String? {
        code.flatMap { GeneratedErrorTexts.commands[$0] }
    }

    private static func rateLimited(_ retryAfter: TimeInterval?) -> String {
        guard let retryAfter, retryAfter >= 1 else { return "Juda ko'p so'rov: birozdan keyin urinib ko'ring" }
        return "Juda ko'p so'rov: \(Int(retryAfter.rounded(.up))) soniyadan keyin urinib ko'ring"
    }
}
