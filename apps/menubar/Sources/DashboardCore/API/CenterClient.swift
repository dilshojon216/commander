import Foundation
import MenuBarCore

/// `/v1` REST klienti: bitta `send` — hamma ekran shu orqali o'qiydi/yozadi (testda soxta klient).
public protocol CenterClient: Sendable {
    func send<Response>(_ endpoint: Endpoint<Response>) async throws(APIError) -> Response
}

/// Haqiqiy HTTP klienti: Bearer token, JSON dekod (generatsiya qilingan tiplar), xato kodlari -> `APIError`.
public struct CenterHTTPClient: CenterClient {
    private let center: URL
    private let transport: any HTTPTransport
    private let tokens: any TokenProviding
    private let timeout: TimeInterval

    public init(center: URL, transport: any HTTPTransport, tokens: any TokenProviding, timeout: TimeInterval = 20) {
        self.center = center
        self.transport = transport
        self.tokens = tokens
        self.timeout = timeout
    }

    public func send<Response>(_ endpoint: Endpoint<Response>) async throws(APIError) -> Response {
        let request = try await makeRequest(endpoint)
        let data: Data
        let http: HTTPURLResponse
        do {
            (data, http) = try await transport.send(request)
        } catch {
            throw .offline
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = Self.errorBody(data)
            throw APIError.from(status: http.statusCode, code: body.error, retryAfter: Self.retryAfter(http), bodyStatus: body.status)
        }
        return try Self.decode(Response.self, from: data)
    }

    // MARK: ichki

    private func makeRequest<Response>(_ endpoint: Endpoint<Response>) async throws(APIError) -> URLRequest {
        guard endpoint.segments.allSatisfy({ !$0.isEmpty && !$0.contains("/") }) else { throw .invalidRequest("yo'l bo'lagi") }
        let path = "/v1/" + endpoint.segments.joined(separator: "/")
        guard let url = CenterURLs.api(center: center, path: path, query: endpoint.query) else { throw .invalidRequest("URL") }
        guard let token = await tokens.bearerToken() else { throw .noToken }

        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let key = endpoint.idempotencyKey { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        do {
            if let body = try endpoint.bodyData() {
                request.httpBody = body
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
        } catch {
            throw .invalidRequest("tana")
        }
        return request
    }

    private static func decode<Response: Decodable>(_ type: Response.Type, from data: Data) throws(APIError) -> Response {
        if data.isEmpty, let empty = EmptyResponse() as? Response { return empty }
        do { return try JSONDecoder().decode(Response.self, from: data) } catch { throw .decoding("\(Response.self)") }
    }

    private struct ErrorBody: Decodable {
        let error: String?
        let status: String?
    }

    private static func errorBody(_ data: Data) -> ErrorBody {
        (try? JSONDecoder().decode(ErrorBody.self, from: data)) ?? ErrorBody(error: nil, status: nil)
    }

    private static func retryAfter(_ response: HTTPURLResponse) -> TimeInterval? {
        response.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
    }
}
