import CommanderContracts
import XCTest
@testable import DashboardCore

final class EndpointTests: XCTestCase {
    func testCacheKeySortsQueryAndIncludesMethodAndPath() {
        let a = Endpoint<EmptyResponse>.get(["sessions"], query: [.init(name: "b", value: "2"), .init(name: "a", value: "1")])
        let b = Endpoint<EmptyResponse>.get(["sessions"], query: [.init(name: "a", value: "1"), .init(name: "b", value: "2")])
        XCTAssertEqual(a.cacheKey, b.cacheKey)
        XCTAssertEqual(a.cacheKey, "GET /sessions?a=1&b=2")
    }

    func testSessionsFilterBuildsOnlySetParameters() {
        XCTAssertEqual(SessionsFilter().queryItems.map(\.name), ["limit"])
        let filter = SessionsFilter(machine: "srv-01", status: "waiting", activeOnly: true, limit: 50, cursor: "c1")
        let query = Dictionary(uniqueKeysWithValues: filter.queryItems.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query, ["limit": "50", "machine": "srv-01", "status": "waiting", "active": "true", "cursor": "c1"])
    }

    func testReadEndpointsAreCachedWritesAreNot() {
        XCTAssertEqual(Endpoints.machines().cacheTTL, CacheTTL.list)
        XCTAssertNil(Endpoints.session(id: "x").cacheTTL, "bitta sessiya jonli: keshlanmaydi")
        XCTAssertNil(Endpoints.dismissAlert(id: "x").cacheTTL)
    }

    func testControlEndpointsDeclareRequiredScope() {
        XCTAssertEqual(Endpoints.machines().scope, .read)
        XCTAssertEqual(Endpoints.decide(approvalId: "a", body: .init(behavior: .allow)).scope, .approve)
        XCTAssertEqual(Endpoints.confirmCommand(id: "c").scope, .approve)
        XCTAssertEqual(Endpoints.cancelCommand(id: "c").scope, .control)
        XCTAssertEqual(Endpoints.dismissAlert(id: "x").scope, .control)
    }

    func testCatalogPaths() {
        XCTAssertEqual(Endpoints.machineHealth(machineId: "m1").segments, ["machines", "m1", "health"])
        XCTAssertEqual(Endpoints.usageSummary().segments, ["usage", "summary"])
        XCTAssertEqual(Endpoints.decide(approvalId: "a1", body: .init(behavior: .deny)).segments, ["approvals", "a1", "decision"])
        XCTAssertEqual(Endpoints.alerts(openOnly: false).query.first?.value, "all")
    }

    func testBodyIsEncodedLazilyToJSON() throws {
        let endpoint = Endpoints.decide(approvalId: "a1", body: .init(behavior: .deny))
        let json = try JSONSerialization.jsonObject(with: XCTUnwrap(endpoint.bodyData())) as? [String: Any]
        XCTAssertEqual(json?["behavior"] as? String, "deny")
        XCTAssertNil(try Endpoints.machines().bodyData())
    }
}
