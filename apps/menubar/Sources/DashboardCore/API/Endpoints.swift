import Foundation

/// `/v1` endpoint katalogi: yo'l satrlari faqat shu `Endpoints+*.swift` fayllarida (magik satr qoidasi).
/// Manba: web dashboard proksi qoidalari (`apps/dashboard/lib/proxy-rules.ts`) va center controller'lari.
public enum Endpoints {
    static func limit(_ value: Int?) -> [URLQueryItem] {
        value.map { [URLQueryItem(name: "limit", value: String($0))] } ?? []
    }
}
