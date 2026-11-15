import DashboardCore
import Foundation

/// Qulflangan o'zgaruvchan qiymat: testlardagi soxta obyektlar `Sendable` bo'lishi uchun.
final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()

    init(_ value: Value) { self.value = value }

    func withValue<T>(_ body: (inout Value) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

final class FakeClock: ClockProviding {
    private let current: Locked<Date>
    init(_ start: Date = Date(timeIntervalSince1970: 1_800_000_000)) { current = Locked(start) }
    var now: Date { current.withValue { $0 } }
    func advance(_ seconds: TimeInterval) { current.withValue { $0 = $0.addingTimeInterval(seconds) } }
}

struct FixedToken: TokenProviding {
    let token: String?
    func bearerToken() async -> String? { token }
}

/// Skriptlangan javobli transport: oxirgi so'rovni saqlaydi.
final class FakeTransport: HTTPTransport {
    enum Reply {
        case response(status: Int, body: Data, headers: [String: String])
        case failure(URLError.Code)
    }

    private let reply: Locked<Reply>
    private let sent = Locked<[URLRequest]>([])

    init(_ reply: Reply) { self.reply = Locked(reply) }

    convenience init(status: Int = 200, body: Data = Data(), headers: [String: String] = [:]) {
        self.init(.response(status: status, body: body, headers: headers))
    }

    var requests: [URLRequest] { sent.withValue { $0 } }
    var lastRequest: URLRequest? { requests.last }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        sent.withValue { $0.append(request) }
        switch reply.withValue({ $0 }) {
        case .failure(let code):
            throw URLError(code)
        case .response(let status, let body, let headers):
            let url = request.url ?? URL(string: "https://center.test")!
            let http = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            return (body, http)
        }
    }
}

/// `clients/fixtures/*.json` (soxta/tozalangan namunalar).
enum Fixtures {
    private static let dir: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("clients/fixtures")

    /// Native testlarning o'z fixture'lari (`Tests/DashboardCoreTests/Fixtures`).
    static func localData(_ name: String) throws -> Data {
        let local = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures")
        return try Data(contentsOf: local.appendingPathComponent(name))
    }

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: dir.appendingPathComponent("\(name).json"))
    }
}

/// So'rov yo'liga qarab javob beradigan transport (`/v1/...` yo'li -> (holat, tana)); topilmasa 404.
final class RoutedTransport: HTTPTransport {
    typealias Route = (status: Int, body: Data)

    private let routes: Locked<[String: Route]>
    private let sent = Locked<[URLRequest]>([])

    init(_ routes: [String: Route]) { self.routes = Locked(routes) }

    var requests: [URLRequest] { sent.withValue { $0 } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        sent.withValue { $0.append(request) }
        let path = request.url?.path ?? ""
        let route = routes.withValue { $0[path] } ?? (404, Data())
        let http = HTTPURLResponse(url: request.url!, statusCode: route.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (route.body, http)
    }
}
