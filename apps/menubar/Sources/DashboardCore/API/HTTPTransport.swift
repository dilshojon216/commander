import Foundation

/// HTTP transporti: ishlab chiqarishda `URLSession`, testda soxta (tarmoqsiz).
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: HTTPTransport {
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// Bearer token manbai (Keychain adapteri ilova qatlamida); token hech qachon log/faylga yozilmaydi.
public protocol TokenProviding: Sendable {
    func bearerToken() async -> String?
}

/// Ma'lum, o'zgarmas token (qisqa umrli klient yaratishda: har chaqiruvda joriy token olinadi).
public struct StaticTokenProvider: TokenProviding {
    private let token: String

    public init(_ token: String) {
        self.token = token
    }

    public func bearerToken() async -> String? { token }
}
