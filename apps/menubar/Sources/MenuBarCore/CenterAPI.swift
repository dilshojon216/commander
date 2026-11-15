import CommanderContracts
import Foundation

public enum APIFailure: Error, Equatable, Sendable {
    /// 401: token yaroqsiz yoki revoke qilingan.
    case unauthorized
    case http(status: Int, code: String?)
    case transport(String)
    case decoding(String)

    public var message: String {
        switch self {
        case .unauthorized: return "Token yaroqsiz yoki bekor qilingan"
        case .http(let s, let c): return "Server xatosi \(s)\(c.map { ": \($0)" } ?? "")"
        case .transport(let m): return "Tarmoq: \(m)"
        case .decoding(let m): return "Javobni o'qib bo'lmadi: \(m)"
        }
    }
}

/// `/v1` REST klienti (Bearer client token). Token hech qachon log/faylga yozilmaydi.
public struct CenterAPI: Sendable, ApprovalDecider {
    public let center: URL
    private let token: String
    private let session: URLSession

    public init(center: URL, token: String, session: URLSession = .shared) {
        self.center = center
        self.token = token
        self.session = session
    }

    // MARK: o'qish

    public func me() async throws(APIFailure) -> ClientDeviceMeResponse {
        try await get("/v1/devices/me")
    }

    /// Snapshot: asosiy qismlar (sessions/machines/limits/approvals) majburiy, qolganlari (alerts/health/queue)
    /// ixtiyoriy — eski center yoki vaqtinchalik xato butun panelni bo'sh qoldirmasin.
    public func snapshot() async throws(APIFailure) -> DashboardSnapshot {
        let active: [URLQueryItem] = [.init(name: "active", value: "true"), .init(name: "limit", value: "500")]
        async let sessions: Result<ListSessionsResponseV1, APIFailure> = fetch("/v1/sessions", query: active)
        async let machines: Result<ListMachinesResponse, APIFailure> = fetch("/v1/machines")
        async let limits: Result<LimitsResponse, APIFailure> = fetch("/v1/limits")
        async let approvals: Result<ListApprovalsResponse, APIFailure> = fetch("/v1/approvals")
        async let alerts: Result<ListAlertsResponse, APIFailure> = fetch("/v1/alerts", query: [.init(name: "state", value: "open")])
        async let health: Result<HealthSummaryResponse, APIFailure> = fetch("/v1/health/summary")
        async let queue: Result<ListQueueResponse, APIFailure> = fetch("/v1/queue")

        let s = await sessions, m = await machines, l = await limits, a = await approvals
        let al = await alerts, h = await health, q = await queue
        return DashboardSnapshot(
            sessions: try s.get().items,
            machines: try m.get().items,
            limits: try l.get(),
            pendingApprovals: try a.get().pending,
            alerts: (try? al.get().items) ?? [],
            health: try? h.get(),
            queue: (try? q.get().items) ?? []
        )
    }

    // MARK: yozish

    public func decide(approvalId: String, body: ApprovalDecisionBody) async -> DecisionOutcome {
        let id = approvalId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? approvalId
        do {
            let (data, status) = try await send("POST", "/v1/approvals/\(id)/decision", body: body)
            return DecisionOutcome.from(status: status, body: data)
        } catch {
            return .failed("Markazga yetib bo'lmadi: \(error.message)")
        }
    }

    /// Unpair: `POST /v1/devices/me/revoke` (lockdown'da ham ruxsat).
    public func revokeSelf() async throws(APIFailure) {
        let (data, status) = try await send("POST", "/v1/devices/me/revoke", body: Optional<Empty>.none)
        if status == 401 { throw .unauthorized }
        guard (200..<300).contains(status) else { throw .http(status: status, code: Self.errorCode(data)) }
    }

    /// `POST /v1/clients/pair` (autentifikatsiyasiz).
    public static func pair(_ req: PairingRequest, deviceName: String, session: URLSession = .shared) async -> Result<ClientPairResponse, PairingFailure> {
        guard let url = CenterURLs.api(center: req.centerURL, path: "/v1/clients/pair") else { return .failure(.network("URL noto'g'ri")) }
        var r = URLRequest(url: url, timeoutInterval: 20)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            r.httpBody = try JSONEncoder().encode(req.body(deviceName: deviceName))
            let (data, resp) = try await session.data(for: r)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else { return .failure(PairingFailure.from(status: status, body: data)) }
            guard let ok = try? JSONDecoder().decode(ClientPairResponse.self, from: data), ok.token.hasPrefix(CommanderContract.clientTokenPrefix) else {
                return .failure(.server(status))
            }
            return .success(ok)
        } catch {
            return .failure(.network(error.localizedDescription))
        }
    }

    // MARK: ichki

    private struct Empty: Encodable {}

    private func fetch<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = []) async -> Result<T, APIFailure> {
        do { return .success(try await get(path, query: query)) } catch { return .failure(error) }
    }

    private func request(_ method: String, _ path: String, query: [URLQueryItem] = []) throws(APIFailure) -> URLRequest {
        guard let url = CenterURLs.api(center: center, path: path, query: query) else { throw .transport("URL noto'g'ri") }
        var r = URLRequest(url: url, timeoutInterval: 20)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        return r
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws(APIFailure) -> T {
        let r = try request("GET", path, query: query)
        let data: Data, status: Int
        do {
            let (d, resp) = try await session.data(for: r)
            data = d
            status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        } catch {
            throw .transport(error.localizedDescription)
        }
        if status == 401 { throw .unauthorized }
        guard (200..<300).contains(status) else { throw .http(status: status, code: Self.errorCode(data)) }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw .decoding("\(T.self)") }
    }

    private func send<B: Encodable>(_ method: String, _ path: String, body: B?) async throws(APIFailure) -> (Data, Int) {
        var r = try request(method, path)
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do { r.httpBody = try JSONEncoder().encode(body) } catch { throw .decoding("encode") }
        }
        do {
            let (d, resp) = try await session.data(for: r)
            return (d, (resp as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw .transport(error.localizedDescription)
        }
    }

    static func errorCode(_ data: Data) -> String? {
        (try? JSONDecoder().decode(ApiError.self, from: data))?.error
    }
}

/// `/ws/client` kadrlarini kodlash/dekodlash (generatsiya qilingan union tiplari orqali).
public enum ClientWire {
    /// Biz obuna bo'ladigan kanallar.
    public static let channels: [ClientChannel] = [.sessions, .machines, .limits, .approvals, .alerts, .health, .queue]

    public static func subscribe(id: String = UUID().uuidString.lowercased(), now: Date = Date()) -> Data? {
        let msg = ClientToServerMessage.subscribe(ClientSubscribeMessage(id: id, ts: epochMs(now), payload: ClientSubscribePayload(channels: channels)))
        return try? JSONEncoder().encode(msg)
    }

    public static func ping(id: String = UUID().uuidString.lowercased(), now: Date = Date()) -> Data? {
        try? JSONEncoder().encode(ClientToServerMessage.ping(ClientPingMessage(id: id, ts: epochMs(now))))
    }

    /// Noma'lum `type` ulanishni buzmaydi (`.unknown`); buzilgan JSON uchun nil.
    public static func decode(_ data: Data) -> ServerToClientMessage? {
        try? JSONDecoder().decode(ServerToClientMessage.self, from: data)
    }

    static func epochMs(_ d: Date) -> Int { Int((d.timeIntervalSince1970 * 1000).rounded()) }
}
