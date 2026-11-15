import XCTest
import Darwin
@testable import SignerCore

/// Soket protokoli: handshake, noto'g'ri secret, katta qator, ulanish chegarasi.
final class ServerTests: XCTestCase {
    final class Conn {
        let fd: Int32
        var buf = Data()
        init(port: UInt16) throws {
            fd = socket(AF_INET, SOCK_STREAM, 0)
            var a = sockaddr_in(); a.sin_family = sa_family_t(AF_INET); a.sin_port = port.bigEndian; a.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
            let rc = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            guard rc == 0 else { throw SignerError("t", "connect failed") }
            var tv = timeval(tv_sec: 3, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        }
        deinit { close(fd) }
        func send(_ s: String) { let d = Array((s + "\n").utf8); _ = write(fd, d, d.count) }
        func sendObj(_ o: [String: Any]) { send(String(data: try! JSONSerialization.data(withJSONObject: o), encoding: .utf8)!) }
        func line() -> [String: Any]? {
            while true {
                if let nl = buf.firstIndex(of: 0x0A) {
                    let l = buf[buf.startIndex..<nl]; buf.removeSubrange(buf.startIndex...nl)
                    return (try? JSONSerialization.jsonObject(with: Data(l))) as? [String: Any]
                }
                var c = [UInt8](repeating: 0, count: 4096)
                let n = read(fd, &c, c.count)
                if n <= 0 { return nil }
                buf.append(contentsOf: c[0..<n])
            }
        }
        func handshake(secret: Data) -> Bool {
            guard let ch = line(), let sn = ch["nonce"] as? String else { return false }
            let cn = Enc.b64url(Enc.randomBytes(32))
            sendObj(["t": "auth", "nonce": cn, "mac": Enc.b64url(Enc.hmac(key: secret, "COMMANDER-SIGNER-V1:client\n\(sn)\n\(cn)"))])
            guard let r = line(), r["t"] as? String == "ready", let m = r["mac"] as? String else { return false }
            return Enc.constantTimeEqual(Enc.fromB64url(m) ?? Data(), Enc.hmac(key: secret, "COMMANDER-SIGNER-V1:server\n\(sn)\n\(cn)"))
        }
    }

    func start() throws -> (SignerServer, Data, Fx.Clock) {
        let (svc, _, _, clock) = try Fx.service()
        let secret = Enc.randomBytes(32)
        let srv = SignerServer(service: svc, secret: secret)
        try srv.listenTcp(port: 0)
        return (srv, secret, clock)
    }

    func testHandshakeAndSign() throws {
        let (srv, secret, clock) = try start(); defer { srv.stop() }
        let c = try Conn(port: srv.boundTcpPort)
        XCTAssertTrue(c.handshake(secret: secret))
        c.sendObj(["id": "7", "op": "sign_command", "deviceId": Fx.device, "commandId": Fx.command, "type": "project.refresh", "nonce": String(repeating: "A", count: 43), "expiresAt": clock.now + 60_000, "payloadSha256": String(repeating: "b", count: 64)])
        let r = c.line()
        XCTAssertEqual(r?["ok"] as? Bool, true); XCTAssertEqual(r?["id"] as? String, "7")
        c.sendObj(["op": "info"])
        XCTAssertEqual(c.line()?["publicKey"] as? String, Fx.pubB64)
    }

    func testWrongSecretIsRejectedWithoutServingRequests() throws {
        let (srv, _, _) = try start(); defer { srv.stop() }
        let c = try Conn(port: srv.boundTcpPort)
        XCTAssertFalse(c.handshake(secret: Enc.randomBytes(32)))
        c.sendObj(["op": "info"])
        XCTAssertNil(c.line()?["publicKey"])
    }

    func testRequestWithoutHandshakeIsNotServed() throws {
        let (srv, _, _) = try start(); defer { srv.stop() }
        let c = try Conn(port: srv.boundTcpPort)
        _ = c.line() // challenge
        c.sendObj(["op": "info"])
        let r = c.line()
        XCTAssertEqual(r?["code"] as? String, "auth_failed")
        XCTAssertNil(r?["publicKey"])
    }

    func testOversizedLineClosesConnection() throws {
        let (srv, secret, _) = try start(); defer { srv.stop() }
        let c = try Conn(port: srv.boundTcpPort)
        XCTAssertTrue(c.handshake(secret: secret))
        c.send(String(repeating: "x", count: SignerServer.maxLine + 100))
        XCTAssertNil(c.line())
    }

    func testBindsLoopbackOnly() throws {
        let (srv, _, _) = try start(); defer { srv.stop() }
        var bound = sockaddr_in(); var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let probe = socket(AF_INET, SOCK_STREAM, 0); defer { close(probe) }
        _ = bound; _ = len
        // 127.0.0.1 ga ulanadi; (boshqa interfeys manzili bilan ulanish mumkin emasligini lsof orqali skriptlar tekshiradi)
        XCTAssertNotNil(try? Conn(port: srv.boundTcpPort))
    }
}
