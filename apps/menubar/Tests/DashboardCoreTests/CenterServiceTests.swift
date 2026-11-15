import CommanderContracts
import MenuBarCore
import XCTest
@testable import DashboardCore

final class CenterServiceTests: XCTestCase {
    private let center = URL(string: "https://center.test")!
    private let ok = 200

    private func service(_ routes: [String: RoutedTransport.Route]) -> (CenterService, RoutedTransport) {
        let transport = RoutedTransport(routes)
        let client = CenterHTTPClient(center: center, transport: transport, tokens: StaticTokenProvider("cmdr_secret"))
        return (CenterService(client: client), transport)
    }

    private func fixture(_ name: String) throws -> RoutedTransport.Route { (200, try Fixtures.data(name)) }

    private func fullSnapshotRoutes() throws -> [String: RoutedTransport.Route] {
        [
            "/v1/sessions": try fixture("sessions"), "/v1/machines": try fixture("machines"), "/v1/limits": try fixture("limits"),
            "/v1/approvals": try fixture("approvals"), "/v1/alerts": try fixture("alerts"),
            "/v1/health/summary": try fixture("health-summary"), "/v1/queue": try fixture("queue"),
        ]
    }

    // MARK: snapshot

    func testSnapshotLoadsEverythingFromFixtures() async throws {
        let (service, transport) = service(try fullSnapshotRoutes())
        let snapshot = try await service.snapshot()
        XCTAssertFalse(snapshot.sessions.isEmpty)
        XCTAssertFalse(snapshot.machines.isEmpty)
        XCTAssertNotNil(snapshot.limits)
        XCTAssertFalse(snapshot.alerts.isEmpty)
        XCTAssertNotNil(snapshot.health)
        let sessionRequest = try XCTUnwrap(transport.requests.first { $0.url?.path == "/v1/sessions" })
        XCTAssertTrue(sessionRequest.url?.query?.contains("active=true") == true)
        XCTAssertTrue(sessionRequest.url?.query?.contains("limit=500") == true)
    }

    func testOptionalPartsMayFailWithoutLosingTheSnapshot() async throws {
        var routes = try fullSnapshotRoutes()
        routes["/v1/alerts"] = (500, Data())
        routes["/v1/health/summary"] = (404, Data())
        routes["/v1/queue"] = (503, Data())
        let (service, _) = service(routes)
        let snapshot = try await service.snapshot()
        XCTAssertTrue(snapshot.alerts.isEmpty)
        XCTAssertNil(snapshot.health)
        XCTAssertTrue(snapshot.queue.isEmpty)
        XCTAssertFalse(snapshot.sessions.isEmpty)
    }

    func testRequiredPartFailureFailsTheSnapshot() async throws {
        var routes = try fullSnapshotRoutes()
        routes["/v1/limits"] = (401, Data(#"{"error":"unauthorized","message":"x"}"#.utf8))
        let (service, _) = service(routes)
        do {
            _ = try await service.snapshot()
            XCTFail("xato kutilgan")
        } catch {
            XCTAssertEqual(error, .unauthorized)
        }
    }

    // MARK: qaror

    private func approvalDecisionBody() throws -> Data {
        let approval = try JSONSerialization.jsonObject(with: Fixtures.data("approval"))
        return try JSONSerialization.data(withJSONObject: ["approval": approval, "delivered": true, "idempotent": false])
    }

    private func decide(status: Int, body: String) async -> DecisionOutcome {
        let (service, _) = service(["/v1/approvals/a1/decision": (status, Data(body.utf8))])
        return await service.decide(approvalId: "a1", body: .init(behavior: .deny))
    }

    func testAcceptedDecisionCarriesApprovalAndDelivery() async throws {
        let (service, transport) = service(["/v1/approvals/a1/decision": (200, try approvalDecisionBody())])
        let outcome = await service.decide(approvalId: "a1", body: .init(behavior: .allow))
        guard case .accepted(_, let delivered) = outcome else { return XCTFail("accepted kutilgan: \(outcome)") }
        XCTAssertTrue(delivered)
        XCTAssertEqual(transport.requests.first?.httpMethod, "POST")
    }

    func testDecisionErrorTableMatchesLegacyBehaviour() async {
        let lockdown = await decide(status: 403, body: #"{"error":"lockdown","message":"x"}"#)
        XCTAssertEqual(lockdown, .lockdown)
        let noScope = await decide(status: 403, body: #"{"error":"insufficient_scope","message":"x"}"#)
        XCTAssertEqual(noScope, .noScope)
        let missing = await decide(status: 404, body: "")
        XCTAssertEqual(missing, .notFound)
        let expired = await decide(status: 409, body: #"{"error":"approval_expired","message":"x"}"#)
        XCTAssertEqual(expired, .expired)
        let resolved = await decide(status: 409, body: #"{"error":"approval_conflict","message":"x","status":"approved"}"#)
        XCTAssertEqual(resolved, .alreadyResolved(status: "approved"))
        let expiredByStatus = await decide(status: 409, body: #"{"error":"approval_conflict","message":"x","status":"expired"}"#)
        XCTAssertEqual(expiredByStatus, .expired)
        let plan = await decide(status: 422, body: #"{"error":"plan_approve_unsupported","message":"x"}"#)
        XCTAssertEqual(plan, .planApproveUnsupported)
        let unauthorized = await decide(status: 401, body: "")
        XCTAssertEqual(unauthorized, .unauthorized)
        let busy = await decide(status: 429, body: "")
        XCTAssertEqual(busy, .failed("Juda ko'p so'rov: birozdan keyin urinib ko'ring"))
    }

    func testUndeliveredDecisionIsAcceptedWithExplanation() async throws {
        let approval = try JSONSerialization.jsonObject(with: Fixtures.data("approval"))
        let body = try JSONSerialization.data(withJSONObject: ["approval": approval, "delivered": false, "idempotent": false])
        let (service, _) = service(["/v1/approvals/a1/decision": (200, body)])
        let outcome = await service.decide(approvalId: "a1", body: .init(behavior: .deny))
        guard case .accepted(_, let delivered) = outcome else { return XCTFail("accepted kutilgan") }
        XCTAssertFalse(delivered)
        XCTAssertNotNil(outcome.message, "yetkazilmagan qaror haqida xabar")
        XCTAssertTrue(outcome.removesCard)
    }

    func testLockdownKeepsCardAndExplainsDenyIsStillPossible() async {
        let outcome = await decide(status: 403, body: #"{"error":"lockdown","message":"Lockdown is active"}"#)
        XCTAssertFalse(outcome.removesCard, "lockdown'da approval pending qoladi: rad etish hamon mumkin")
        XCTAssertEqual(outcome.message, "Lockdown: faqat rad etish mumkin")
    }

    func testResolvedElsewhereRemovesCardWithMessage() async {
        let outcome = await decide(status: 409, body: #"{"error":"approval_conflict","message":"x","status":"approved"}"#)
        XCTAssertTrue(outcome.removesCard)
        XCTAssertEqual(outcome.message, "Allaqachon hal qilingan (terminalda javob berildi)")
    }

    func testMalformedSuccessBodyIsReportedNotCrashed() async {
        let outcome = await decide(status: 200, body: "{}")
        guard case .failed = outcome else { return XCTFail("failed kutilgan") }
    }

    func testUnknownServerFailureBecomesFailedWithText() async {
        let outcome = await decide(status: 500, body: "")
        guard case .failed(let message) = outcome else { return XCTFail("failed kutilgan") }
        XCTAssertFalse(message.isEmpty)
        XCTAssertFalse(outcome.removesCard)
    }

    func testTransportFailureSaysCenterUnreachable() async {
        let client = CenterHTTPClient(center: center, transport: FakeTransport(.failure(.notConnectedToInternet)), tokens: StaticTokenProvider("t"))
        let outcome = await CenterService(client: client).decide(approvalId: "a1", body: .init(behavior: .deny))
        guard case .failed(let message) = outcome else { return XCTFail("failed kutilgan") }
        XCTAssertTrue(message.hasPrefix("Markazga yetib bo'lmadi"))
    }

    // MARK: unpair va me

    func testRevokeSelfPostsAndSurfacesUnauthorized() async throws {
        let (okService, transport) = service(["/v1/devices/me/revoke": (204, Data())])
        try await okService.revokeSelf()
        XCTAssertEqual(transport.requests.first?.httpMethod, "POST")

        let (rejected, _) = service(["/v1/devices/me/revoke": (401, Data())])
        do { try await rejected.revokeSelf(); XCTFail("xato kutilgan") } catch { XCTAssertEqual(error, .unauthorized) }
    }

    func testMeDecodesDeviceInfo() async throws {
        let (service, _) = service(["/v1/devices/me": try fixture("ws/device-me")])
        let me = try await service.me()
        XCTAssertFalse(me.scopes.isEmpty)
    }

    // MARK: juftlash

    func testPairingSucceedsOnlyWithClientTokenPrefix() async throws {
        let request = PairingRequest(centerURL: center, code: "ABCDE-FGHJK")
        let transport = RoutedTransport(["/v1/clients/pair": try fixture("ws/pair-response")])
        let result = await PairingClient.pair(request, deviceName: "Mac", transport: transport)
        guard case .success(let pair) = result else { return XCTFail("success kutilgan") }
        XCTAssertTrue(pair.token.hasPrefix(CommanderContract.clientTokenPrefix))
        XCTAssertNil(transport.requests.first?.value(forHTTPHeaderField: "Authorization"), "juftlash autentifikatsiyasiz")
    }

    func testPairingRejectsBadServerResponses() async throws {
        let request = PairingRequest(centerURL: center, code: "ABCDE-FGHJK")
        let bogus = await PairingClient.pair(request, deviceName: "Mac", transport: RoutedTransport(["/v1/clients/pair": (200, Data(#"{"nope":1}"#.utf8))]))
        guard case .failure = bogus else { return XCTFail("failure kutilgan") }
        let denied = await PairingClient.pair(request, deviceName: "Mac", transport: RoutedTransport(["/v1/clients/pair": (401, Data())]))
        guard case .failure = denied else { return XCTFail("failure kutilgan") }
    }
}
