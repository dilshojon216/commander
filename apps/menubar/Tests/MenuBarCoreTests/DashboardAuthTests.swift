import MenuBarCore
import XCTest

final class DashboardAuthTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:4318")!

    // MARK: sahifa xabarlari

    func testParsesKnownActions() {
        XCTAssertEqual(DashboardAuthMessage.parse(["action": "status"]), .status)
        XCTAssertEqual(DashboardAuthMessage.parse(["action": "login"]), .login)
        XCTAssertEqual(DashboardAuthMessage.parse(["action": "elevate"]), .elevate)
        XCTAssertEqual(DashboardAuthMessage.parse(["action": "pair", "setupCode": "abcd-efgh"]), .pair(setupCode: "ABCDEFGH"))
    }

    func testRejectsUnknownOrMalformedMessages() {
        XCTAssertNil(DashboardAuthMessage.parse("login"))
        XCTAssertNil(DashboardAuthMessage.parse(["action": "delete-everything"]))
        XCTAssertNil(DashboardAuthMessage.parse(["action": 5]))
        XCTAssertNil(DashboardAuthMessage.parse([:]))
        XCTAssertNil(DashboardAuthMessage.parse(["action": "pair"]))
        XCTAssertNil(DashboardAuthMessage.parse(["action": "pair", "setupCode": "1234"]))
        XCTAssertNil(DashboardAuthMessage.parse(["action": "pair", "setupCode": "ABCD-EFGH-IJKL"]))
        XCTAssertNil(DashboardAuthMessage.parse(["action": "pair", "setupCode": "ABCD-EFG0"])) // 0 alifboda yo'q
        XCTAssertNil(DashboardAuthMessage.parse(["action": "pair", "setupCode": String(repeating: "A", count: 64)]))
    }

    func testSetupCodeNormalization() {
        XCTAssertEqual(DashboardAuthMessage.normalizeSetupCode(" ab-cd 23 45 "), "ABCD2345")
        XCTAssertTrue(DashboardAuthMessage.isWellFormedSetupCode("ABCD-2345"))
        XCTAssertFalse(DashboardAuthMessage.isWellFormedSetupCode("ABCD-234"))
    }

    // MARK: so'rovlar

    func testRequestsTargetDashboardAuthEndpoints() throws {
        let pair = DashboardAuthRequests.pair(base: base, setupCode: "ABCDEFGH", deviceName: "Mac")
        XCTAssertEqual(pair.url?.absoluteString, "http://127.0.0.1:4318/api/auth/app/pair")
        XCTAssertEqual(pair.httpMethod, "POST")
        XCTAssertNil(pair.value(forHTTPHeaderField: "Authorization"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(pair.httpBody)) as? [String: String])
        XCTAssertEqual(body["setupCode"], "ABCDEFGH")

        let login = DashboardAuthRequests.login(base: base, secret: "S3CRET")
        XCTAssertEqual(login.url?.path, "/api/auth/app/login")
        XCTAssertEqual(login.value(forHTTPHeaderField: "Authorization"), "Bearer S3CRET")
        XCTAssertFalse(login.httpShouldHandleCookies)
        XCTAssertNil(login.value(forHTTPHeaderField: "Origin"))

        let tok = DashboardAuthRequests.elevationToken(base: base, secret: "S3CRET")
        XCTAssertEqual(tok.url?.path, "/api/auth/app/elevation-token")
    }

    func testRequestsIgnoreBasePathAndQuery() {
        let weird = URL(string: "http://127.0.0.1:4318/evil?x=1#f")!
        XCTAssertEqual(DashboardAuthRequests.login(base: weird, secret: "x").url?.absoluteString, "http://127.0.0.1:4318/api/auth/app/login")
    }

    // MARK: javoblar

    func testParsesSecretAndToken() {
        let secret = String(repeating: "a", count: 43)
        XCTAssertEqual(DashboardAuthResponse.secret(Data(#"{"ok":true,"secret":"\#(secret)"}"#.utf8)), secret)
        XCTAssertNil(DashboardAuthResponse.secret(Data(#"{"ok":true,"secret":"short"}"#.utf8)))
        XCTAssertNil(DashboardAuthResponse.secret(Data("nope".utf8)))
        XCTAssertEqual(DashboardAuthResponse.token(Data(#"{"ok":true,"token":"0123456789abcdefghij"}"#.utf8)), "0123456789abcdefghij")
        XCTAssertNil(DashboardAuthResponse.token(Data(#"{"token":"x"}"#.utf8)))
        XCTAssertEqual(DashboardAuthResponse.errorCode(Data(#"{"error":"invalid_app_secret"}"#.utf8)), "invalid_app_secret")
    }

    func testExtractsOnlyTheSessionCookie() throws {
        let sid = String(repeating: "x", count: 43)
        let ok = HTTPURLResponse(url: base, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "commander_session=\(sid); Path=/; HttpOnly; SameSite=Strict; Max-Age=43200"])!
        let c = try XCTUnwrap(DashboardAuthResponse.sessionCookie(from: ok, url: base))
        XCTAssertEqual(c.value, sid)
        XCTAssertTrue(c.isHTTPOnly)
        XCTAssertEqual(c.path, "/")
        let other = HTTPURLResponse(url: base, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "other=1; Path=/"])!
        XCTAssertNil(DashboardAuthResponse.sessionCookie(from: other, url: base))
        let empty = HTTPURLResponse(url: base, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "commander_session=; Path=/; Max-Age=0"])!
        XCTAssertNil(DashboardAuthResponse.sessionCookie(from: empty, url: base))
    }

    // MARK: ko'prikka ishonch

    func testBridgeTrustsOnlyMainFrameOfDashboardOrigin() {
        XCTAssertTrue(DashboardAuthTrust.isTrusted(origin: URL(string: "http://127.0.0.1:4318/login"), isMainFrame: true, base: base))
        XCTAssertTrue(DashboardAuthTrust.isTrusted(origin: URL(string: "http://localhost:4318/"), isMainFrame: true, base: base))
        XCTAssertFalse(DashboardAuthTrust.isTrusted(origin: URL(string: "http://127.0.0.1:4318/login"), isMainFrame: false, base: base))
        XCTAssertFalse(DashboardAuthTrust.isTrusted(origin: URL(string: "https://evil.example/"), isMainFrame: true, base: base))
        XCTAssertFalse(DashboardAuthTrust.isTrusted(origin: URL(string: "http://127.0.0.1:9999/"), isMainFrame: true, base: base))
        XCTAssertFalse(DashboardAuthTrust.isTrusted(origin: nil, isMainFrame: true, base: base))
    }

    func testRepliesNeverContainSecret() {
        let r = DashboardAuthReply.token("T0KEN")
        XCTAssertEqual(r["token"] as? String, "T0KEN")
        XCTAssertNil(r["secret"])
        XCTAssertEqual(DashboardAuthReply.status(paired: true)["paired"] as? Bool, true)
        XCTAssertEqual(DashboardAuthReply.failure("cancelled")["error"] as? String, "cancelled")
    }
}
