import Foundation

/// `CenterClient` ustidagi kesh qatlami: TTL'li GET'lar keshdan, eskirgani darhol beriladi va fonda yangilanadi.
/// Har qanday yozuv (GET emas) keshni tozalaydi. Jonli hodisalar keshni yamamaydi (docs/NATIVE-DASHBOARD.md, 3.2).
public struct CachedCenterClient: CenterClient {
    private let base: any CenterClient
    private let cache: ResponseCache

    public init(base: any CenterClient, cache: ResponseCache) {
        self.base = base
        self.cache = cache
    }

    public func send<Response>(_ endpoint: Endpoint<Response>) async throws(APIError) -> Response {
        guard endpoint.method == .get, let ttl = endpoint.cacheTTL else {
            let response = try await base.send(endpoint)
            if endpoint.method != .get { await cache.removeAll() }
            return response
        }
        let key = endpoint.cacheKey
        switch await cache.lookup(key, ttl: ttl, as: Response.self) {
        case .fresh(let value):
            return value
        case .stale(let value):
            refresh(endpoint, key: key)
            return value
        case .miss:
            let response = try await base.send(endpoint)
            await cache.store(key, value: response)
            return response
        }
    }

    private func refresh<Response>(_ endpoint: Endpoint<Response>, key: String) {
        let base = self.base, cache = self.cache
        Task {
            if let fresh = try? await base.send(endpoint) { await cache.store(key, value: fresh) }
        }
    }
}
