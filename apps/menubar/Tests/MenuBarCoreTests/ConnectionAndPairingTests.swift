import CommanderContracts
import MenuBarCore
import XCTest

final class ReconnectTests: XCTestCase {
    func testBackoffGrowsAndCaps() {
        let p = ReconnectPolicy(base: 1, factor: 2, maxDelay: 60, jitter: 0.2)
        XCTAssertEqual(p.delay(attempt: 1, random: 0.5), 1, accuracy: 0.0001)
        XCTAssertEqual(p.delay(attempt: 2, random: 0.5), 2, accuracy: 0.0001)
        XCTAssertEqual(p.delay(attempt: 4, random: 0.5), 8, accuracy: 0.0001)
        XCTAssertEqual(p.delay(attempt: 20, random: 0.5), 60, accuracy: 0.0001)
        // Jitter ±20%, lekin max'dan oshmaydi.
        XCTAssertEqual(p.delay(attempt: 3, random: 0), 3.2, accuracy: 0.0001)
        XCTAssertEqual(p.delay(attempt: 3, random: 0.999999), 4.8, accuracy: 0.001)
        XCTAssertEqual(p.delay(attempt: 20, random: 0.999999), 60, accuracy: 0.0001)
    }

    func testCloseDecisions() {
        XCTAssertEqual(CloseDecision.from(code: 1001), .reconnectNow)
        XCTAssertEqual(CloseDecision.from(code: 4003), .reconnectSlow)
        XCTAssertEqual(CloseDecision.from(code: 4008), .reconnect)
        XCTAssertEqual(CloseDecision.from(code: 4002), .reconnect)
        XCTAssertEqual(CloseDecision.from(code: nil), .reconnect)
        guard case .stop = CloseDecision.from(code: 4001) else { return XCTFail("4001 -> stop") }
        guard case .stop = CloseDecision.from(code: 4010) else { return XCTFail("4010 -> stop") }
    }

    func testReconnectStateSequenceAndReset() {
        var r = ReconnectState(policy: ReconnectPolicy(base: 1, factor: 2, maxDelay: 30, jitter: 0))
        XCTAssertEqual(r.next(after: .reconnect, random: 0.5), 1)
        XCTAssertEqual(r.next(after: .reconnect, random: 0.5), 2)
        XCTAssertEqual(r.next(after: .reconnect, random: 0.5), 4)
        XCTAssertEqual(r.attempt, 3)
        r.connected()
        XCTAssertEqual(r.attempt, 0)
        XCTAssertEqual(r.next(after: .reconnect, random: 0.5), 1, "auth.ok dan keyin backoff boshidan")
        XCTAssertNil(r.next(after: .stop(reason: "revoked"), random: 0.5), "revoke: qayta ulanmaslik")
        XCTAssertEqual(r.next(after: .reconnectNow, random: 0.5), 0.5)
        XCTAssertEqual(r.attempt, 0)
        XCTAssertEqual(r.next(after: .reconnectSlow, random: 0.5), ReconnectState.slowDelay)
    }

    func testURLs() {
        let c = URL(string: "https://mac.tailnet.ts.net:4317")!
        XCTAssertEqual(CenterURLs.webSocket(center: c)?.absoluteString, "wss://mac.tailnet.ts.net:4317/ws/client")
        XCTAssertEqual(CenterURLs.webSocket(center: URL(string: "http://127.0.0.1:4317")!)?.absoluteString, "ws://127.0.0.1:4317/ws/client")
        XCTAssertNil(CenterURLs.webSocket(center: URL(string: "ftp://x")!))
        XCTAssertEqual(CenterURLs.api(center: c, path: "/v1/sessions", query: [.init(name: "active", value: "true")])?.absoluteString,
                       "https://mac.tailnet.ts.net:4317/v1/sessions?active=true")
    }

    func testTokenGoesToSubprotocolNotQuery() {
        let protocols = ClientWebSocketAuth.subprotocols(token: "cmdr_secret")
        XCTAssertEqual(protocols, ["commander.v1", "cmdr-token.cmdr_secret"])
        let ws = CenterURLs.webSocket(center: URL(string: "https://mac.ts.net?token=leak")!)!
        XCTAssertNil(ws.query, "query string tashlab yuboriladi")
    }
}

final class ClientWireTests: XCTestCase {
    func testSubscribeEnvelope() throws {
        let data = try XCTUnwrap(ClientWire.subscribe(id: "00000000-0000-4000-8000-000000000001", now: Date(timeIntervalSince1970: 1)))
        let o = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(o["type"] as? String, "subscribe")
        XCTAssertEqual(o["v"] as? Int, 1)
        XCTAssertEqual(o["ts"] as? Int, 1000)
        XCTAssertEqual((o["payload"] as? [String: Any])?["channels"] as? [String],
                       ["sessions", "machines", "limits", "approvals", "alerts", "health", "queue"])
        // Kanallar kontraktdagi ro'yxatda bo'lishi shart.
        for c in ClientWire.channels { XCTAssertTrue(CommanderContract.clientChannels.contains(c.rawValue)) }
    }

    func testDecodeFixturesAndGarbage() throws {
        XCTAssertNotNil(ClientWire.decode(try Fixtures.data("ws/server-auth-ok")))
        guard case .unknown(let type, _)? = ClientWire.decode(try Fixtures.data("ws/server-future-unknown")) else {
            return XCTFail("noma'lum tur .unknown bo'lishi kerak")
        }
        XCTAssertEqual(type, "something.from.the.future")
        XCTAssertNil(ClientWire.decode(Data("not json".utf8)))
        XCTAssertNotNil(ClientWire.ping())
    }
}

final class PairingTests: XCTestCase {
    func testLink() throws {
        let r = try PairingRequest.fromLink("commander://pair?c=https%3A%2F%2Fmac.tail.ts.net&code=abcde%20fghjk&fp=XYZ").get()
        XCTAssertEqual(r.centerURL.absoluteString, "https://mac.tail.ts.net")
        XCTAssertEqual(r.code, "ABCDE-FGHJK")
        XCTAssertEqual(r.fingerprint, "XYZ")
        XCTAssertEqual(PairingRequest.fromLink("commander://pair?c=http://evil.example&code=ABCDE-FGHJK"), .failure(.invalidLink),
                       "https bo'lmagan (loopback emas) center rad etiladi")
        XCTAssertEqual(PairingRequest.fromLink("https://x"), .failure(.invalidLink))
        XCTAssertEqual(PairingRequest.fromLink("commander://pair?c=https://x.ts.net&code=AB"), .failure(.invalidCode))
    }

    func testManual() throws {
        let r = try PairingRequest.manual(center: " https://mac.tail.ts.net/ ", code: "abcdefghjk").get()
        XCTAssertEqual(r.centerURL.absoluteString, "https://mac.tail.ts.net")
        XCTAssertEqual(r.code, "ABCDE-FGHJK")
        XCTAssertEqual(PairingRequest.manual(center: "mac.tail.ts.net", code: "ABCDEFGHJK"), .failure(.invalidCenterURL))
        XCTAssertEqual(PairingRequest.manual(center: "http://10.0.0.1", code: "ABCDEFGHJK"), .failure(.invalidCenterURL))
        XCTAssertNoThrow(try PairingRequest.manual(center: "http://127.0.0.1:4317", code: "ABCDE-FGHJK").get())
        XCTAssertEqual(PairingRequest.manual(center: "https://x.ts.net", code: "ABC!DEFGHJ"), .failure(.invalidCode))
        // Havola maydoni to'ldirilgan bo'lsa u ustun.
        XCTAssertEqual(try PairingRequest.parse(link: "commander://pair?c=https://a.ts.net&code=ABCDEFGHJK", center: "https://b.ts.net", code: "x").get().centerURL.host, "a.ts.net")
    }

    func testBodyMatchesContractFixtureShape() throws {
        let r = try PairingRequest.manual(center: "https://mac.ts.net", code: "ABCDE-FGHJK").get()
        let body = r.body(deviceName: "  Alex's MacBook  ")
        XCTAssertEqual(body.platform, "macos")
        XCTAssertEqual(body.deviceName, "Alex's MacBook")
        XCTAssertNil(body.publicKey)
        XCTAssertEqual(r.body(deviceName: "").deviceName, "Mac")
        let fixture = try Fixtures.decode(ClientPairBody.self, "ws/pair-body")
        XCTAssertEqual(Set((try Fixtures.json(body) as! [String: Any]).keys), Set((try Fixtures.json(fixture) as! [String: Any]).keys).subtracting(["publicKey"]))
        // Javob fixture'i dekodlanadi va token prefiksi kontrakt bilan mos.
        let resp = try Fixtures.decode(ClientPairResponse.self, "ws/pair-response")
        XCTAssertTrue(resp.token.hasPrefix(CommanderContract.clientTokenPrefix))
    }

    func testFailureMapping() {
        func b(_ o: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: o) }
        XCTAssertEqual(PairingFailure.from(status: 401, body: b(["error": "invalid_pairing_code", "message": "x"])), .invalidCode)
        XCTAssertEqual(PairingFailure.from(status: 429, body: Data()), .rateLimited)
        XCTAssertEqual(PairingFailure.from(status: 403, body: b(["error": "lockdown", "message": "x"])), .lockdown)
        XCTAssertEqual(PairingFailure.from(status: 400, body: b(["error": "bad_request", "message": "deviceName"])), .badRequest("deviceName"))
        XCTAssertEqual(PairingFailure.from(status: 503, body: Data()), .server(503))
    }
}
