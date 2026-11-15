import Foundation

public enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
}

/// Endpoint talab qiladigan client-token ruxsati (`/v1` `@ClientAuth(scope)`).
public enum RequiredScope: String, Sendable {
    case read, approve, control
}

/// Javobi bo'sh yoki ahamiyatsiz endpoint'lar uchun (204 yoki tanasi kerak bo'lmagan yozuvlar).
public struct EmptyResponse: Decodable, Sendable, Equatable {
    public init() {}
    public init(from decoder: Decoder) throws {}
}

/// Bitta `/v1` so'rovi: metod, yo'l bo'laklari, query, ruxsat va (kerak bo'lsa) tana. Yo'l satrlari faqat `Endpoints+*.swift` katalogida.
public struct Endpoint<Response: Decodable & Sendable>: Sendable {
    public let method: HTTPMethod
    public let segments: [String]
    public let query: [URLQueryItem]
    public let scope: RequiredScope
    /// `Idempotency-Key` sarlavhasi (buyruq yaratishda).
    public let idempotencyKey: String?
    /// Faqat GET: javob shu muddatgacha keshdan beriladi (`CacheTTL`).
    public let cacheTTL: TimeInterval?
    private let encodeBody: (@Sendable () throws -> Data)?

    public init(
        _ method: HTTPMethod,
        _ segments: [String],
        query: [URLQueryItem] = [],
        scope: RequiredScope = .read,
        idempotencyKey: String? = nil,
        cacheTTL: TimeInterval? = nil,
        encodeBody: (@Sendable () throws -> Data)? = nil
    ) {
        self.method = method
        self.segments = segments
        self.query = query
        self.scope = scope
        self.idempotencyKey = idempotencyKey
        self.cacheTTL = cacheTTL
        self.encodeBody = encodeBody
    }

    public static func get(_ segments: [String], query: [URLQueryItem] = [], cacheTTL: TimeInterval? = nil) -> Self {
        Self(.get, segments, query: query, cacheTTL: cacheTTL)
    }

    public static func post<Body: Encodable & Sendable>(
        _ segments: [String], body: Body, scope: RequiredScope, idempotencyKey: String? = nil
    ) -> Self {
        Self(.post, segments, scope: scope, idempotencyKey: idempotencyKey, encodeBody: { try JSONEncoder().encode(body) })
    }

    /// Tanasiz yozuv (masalan `dismiss`, `cancel`).
    public static func post(_ segments: [String], scope: RequiredScope) -> Self {
        Self(.post, segments, scope: scope)
    }

    public func bodyData() throws -> Data? { try encodeBody?() }

    /// Kesh kaliti: metod + yo'l + saralangan query.
    public var cacheKey: String {
        let q = query.sorted { $0.name < $1.name }.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&")
        return "\(method.rawValue) /" + segments.joined(separator: "/") + (q.isEmpty ? "" : "?" + q)
    }
}
