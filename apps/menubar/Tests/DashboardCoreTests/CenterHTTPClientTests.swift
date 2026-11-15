import CommanderContracts
import XCTest
@testable import DashboardCore

final class CenterHTTPClientTests: XCTestCase {
    private let center = URL(string: "https://center.test")!

    private func client(_ transport: FakeTransport, token: String? = "cmdr_secret") -> CenterHTTPClient {
        CenterHTTPClient(center: center, transport: transport, tokens: FixedToken(token: token))
    }

    func testGetDecodesFixtureAndSendsBearerAndAccept() async throws {
        let transport = FakeTransport(body: try Fixtures.data("machines"))
        let result = try await client(transport).send(Endpoints.machines())
        XCTAssertFalse(result.items.isEmpty)
        let request = try XCTUnwrap(transport.lastRequest)
        XCTAssertEqual(request.url?.absoluteString, "https://center.test/v1/machines")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer cmdr_secret")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertNil(request.httpBody)
    }

    func testQueryIsAppendedAndPathSegmentsStaySeparate() async throws {
        let transport = FakeTransport(body: try Fixtures.data("session-events"))
        _ = try await client(transport).send(Endpoints.sessionEvents(id: "abc-1", limit: 5))
        XCTAssertEqual(transport.lastRequest?.url?.absoluteString, "https://center.test/v1/sessions/abc-1/events?limit=5")
    }

    func testPostSendsJSONBodyAndIdempotencyKey() async throws {
        let transport = FakeTransport(body: try Fixtures.data("commands"))
        let body = try JSONDecoder().decode(CreateCommandBody.self, from: Fixtures.data("ws/create-command-prompt"))
        _ = try? await client(transport).send(Endpoints.createCommand(body, idempotencyKey: "key-12345678"))
        let request = try XCTUnwrap(transport.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "key-12345678")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNotNil(request.httpBody)
    }

    func testEmptyBodyDecodesAsEmptyResponse() async throws {
        let transport = FakeTransport(status: 204)
        let result = try await client(transport).send(Endpoints.dismissAlert(id: "a1"))
        XCTAssertEqual(result, EmptyResponse())
    }

    func testHTTPErrorsMapToAPIErrorUsingBodyCode() async {
        let lockdown = Data(#"{"error":"lockdown","message":"x"}"#.utf8)
        await assertThrows(.lockdown, FakeTransport(status: 403, body: lockdown))
        await assertThrows(.unauthorized, FakeTransport(status: 401, body: Data(#"{"error":"unauthorized","message":"x"}"#.utf8)))
        await assertThrows(.rateLimited(retryAfter: 9), FakeTransport(status: 429, headers: ["Retry-After": "9"]))
        await assertThrows(.server(status: 503), FakeTransport(status: 503))
        await assertThrows(.notFound, FakeTransport(status: 404, body: Data("not json".utf8)))
    }

    func testTransportFailureIsOffline() async {
        await assertThrows(.offline, FakeTransport(.failure(.notConnectedToInternet)))
    }

    func testMalformedSuccessBodyIsDecodingError() async {
        let transport = FakeTransport(body: Data(#"{"unexpected":true}"#.utf8))
        do {
            _ = try await client(transport).send(Endpoints.machines())
            XCTFail("xato kutilgan")
        } catch {
            XCTAssertEqual(error, .decoding("ListMachinesResponse"))
        }
    }

    func testMissingTokenFailsWithoutNetworkCall() async {
        let transport = FakeTransport()
        do {
            _ = try await client(transport, token: nil).send(Endpoints.machines())
            XCTFail("xato kutilgan")
        } catch {
            XCTAssertEqual(error, .noToken)
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testSegmentWithSlashIsRejectedBeforeSending() async {
        let transport = FakeTransport()
        do {
            _ = try await client(transport).send(Endpoints.session(id: "../admin"))
            XCTFail("xato kutilgan")
        } catch {
            XCTAssertEqual(error, .invalidRequest("yo'l bo'lagi"))
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testTokenNeverAppearsInErrorDescription() async {
        do {
            _ = try await client(FakeTransport(status: 500)).send(Endpoints.machines())
        } catch {
            XCTAssertFalse("\(error)".contains("cmdr_secret"))
            XCTAssertFalse(ErrorText.message(for: error).contains("cmdr_secret"))
        }
    }

    private func assertThrows(_ expected: APIError, _ transport: FakeTransport, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await client(transport).send(Endpoints.machines())
            XCTFail("xato kutilgan", file: file, line: line)
        } catch {
            XCTAssertEqual(error, expected, file: file, line: line)
        }
    }
}
