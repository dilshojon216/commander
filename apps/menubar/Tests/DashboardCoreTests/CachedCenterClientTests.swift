import CommanderContracts
import XCTest
@testable import DashboardCore

/// Sanaydigan asosiy klient: javob tanasi `json[cacheKey]` dan dekodlanadi.
private final class CountingClient: CenterClient {
    private let json: Locked<[String: Data]>
    private let calls = Locked<[String: Int]>([:])

    init(json: [String: Data]) { self.json = Locked(json) }

    func setJSON(_ data: Data, for key: String) { json.withValue { $0[key] = data } }
    func callCount(_ key: String) -> Int { calls.withValue { $0[key, default: 0] } }

    func send<Response>(_ endpoint: Endpoint<Response>) async throws(APIError) -> Response {
        let key = endpoint.cacheKey
        calls.withValue { $0[key, default: 0] += 1 }
        guard let data = json.withValue({ $0[key] }) else { throw .notFound }
        do { return try JSONDecoder().decode(Response.self, from: data) } catch { throw .decoding("\(Response.self)") }
    }
}

final class CachedCenterClientTests: XCTestCase {
    private let machinesKey = "GET /machines"

    private func make() throws -> (CachedCenterClient, CountingClient, FakeClock) {
        let base = CountingClient(json: [machinesKey: try Fixtures.data("machines")])
        let clock = FakeClock()
        return (CachedCenterClient(base: base, cache: ResponseCache(clock: clock)), base, clock)
    }

    func testSecondReadWithinTTLIsServedFromCache() async throws {
        let (client, base, _) = try make()
        _ = try await client.send(Endpoints.machines())
        _ = try await client.send(Endpoints.machines())
        XCTAssertEqual(base.callCount(machinesKey), 1)
    }

    func testStaleReadReturnsOldValueAndRefreshesInBackground() async throws {
        let (client, base, clock) = try make()
        let first = try await client.send(Endpoints.machines())
        clock.advance(CacheTTL.list + 1)
        let stale = try await client.send(Endpoints.machines())
        XCTAssertEqual(stale.items.count, first.items.count, "eskirgan qiymat darhol beriladi")
        let key = machinesKey
        try await waitUntil { base.callCount(key) == 2 }
    }

    func testWriteClearsCache() async throws {
        let (client, base, _) = try make()
        base.setJSON(Data("{}".utf8), for: "POST /alerts/a1/dismiss")
        _ = try await client.send(Endpoints.machines())
        _ = try await client.send(Endpoints.dismissAlert(id: "a1"))
        _ = try await client.send(Endpoints.machines())
        XCTAssertEqual(base.callCount(machinesKey), 2, "yozuvdan keyin kesh tozalangan")
    }

    func testEndpointWithoutTTLIsNeverCached() async throws {
        let (client, base, _) = try make()
        base.setJSON(try Fixtures.data("session-detail"), for: "GET /sessions/s1")
        _ = try await client.send(Endpoints.session(id: "s1"))
        _ = try await client.send(Endpoints.session(id: "s1"))
        XCTAssertEqual(base.callCount("GET /sessions/s1"), 2)
    }

    func testFailureIsNotCached() async throws {
        let (client, base, _) = try make()
        base.setJSON(Data("not json".utf8), for: machinesKey)
        do { _ = try await client.send(Endpoints.machines()); XCTFail("xato kutilgan") } catch {}
        base.setJSON(try Fixtures.data("machines"), for: machinesKey)
        _ = try await client.send(Endpoints.machines())
        XCTAssertEqual(base.callCount(machinesKey), 2)
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: @escaping @Sendable () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("shart bajarilmadi") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
