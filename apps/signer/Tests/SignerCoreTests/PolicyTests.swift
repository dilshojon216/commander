import XCTest
@testable import SignerCore

final class PolicyTests: XCTestCase {
    let now: Int64 = 1_900_000_000_000
    let policy = SigningPolicy()

    func testAcceptsWellFormed() throws { try policy.validate(Fx.req(now: now), nowMs: now) }

    func testCanonicalStringMatchesContract() {
        let r = Fx.req(now: now, exp: 1_900_000_000_000)
        XCTAssertEqual(SigningPolicy.canonicalString(r), ["COMMANDER-CMD-V1", Fx.device, Fx.command, "project.refresh", String(repeating: "A", count: 43), "1900000000000", String(repeating: "b", count: 64)].joined(separator: "\n"))
        XCTAssertFalse(SigningPolicy.canonicalString(r).hasSuffix("\n"))
    }

    func testCanonicalLowercasesIds() {
        var r = Fx.req(now: now)
        r.deviceId = Fx.device.uppercased(); r.payloadSha256 = String(repeating: "B", count: 64)
        XCTAssertTrue(SigningPolicy.canonicalString(r).contains(Fx.device))
        XCTAssertTrue(SigningPolicy.canonicalString(r).hasSuffix(String(repeating: "b", count: 64)))
    }

    func testGoldenSignatureMatchesNodeVector() throws {
        let r = Fx.req(now: now, exp: 1_900_000_000_000)
        // CryptoKit Ed25519 imzolari tasodifiylashtirilgan (deterministik emas): bayt tengligi emas, tekshiruv.
        XCTAssertTrue(Fx.verify(sig: Fx.goldenSig, message: SigningPolicy.canonicalString(r), publicB64: Fx.pubB64))
        let own = try SignerService.sign(seed: Fx.seed, message: SigningPolicy.canonicalString(r))
        XCTAssertTrue(Fx.verify(sig: own, message: SigningPolicy.canonicalString(r), publicB64: Fx.pubB64))
    }

    func testRejectsMalformedFields() {
        var r = Fx.req(now: now)
        r.deviceId = "not-a-uuid"
        XCTAssertThrowsError(try policy.validate(r, nowMs: now)) { XCTAssertEqual($0 as? PolicyViolation, .badField("deviceId")) }
        r = Fx.req(now: now); r.commandId = Fx.command + "\nx"
        XCTAssertThrowsError(try policy.validate(r, nowMs: now))
        r = Fx.req(now: now); r.nonce = "short"
        XCTAssertThrowsError(try policy.validate(r, nowMs: now))
        r = Fx.req(now: now); r.payloadSha256 = String(repeating: "z", count: 64)
        XCTAssertThrowsError(try policy.validate(r, nowMs: now))
    }

    func testRejectsNewlineInjectionInType() {
        XCTAssertThrowsError(try policy.validate(Fx.req(now: now, type: "project.refresh\n" + Fx.device), nowMs: now))
    }

    func testRejectsUnknownType() {
        XCTAssertThrowsError(try policy.validate(Fx.req(now: now, type: "shell.exec"), nowMs: now)) { if case .unknownType = $0 as! PolicyViolation {} else { XCTFail() } }
    }

    func testExpiryBounds() throws {
        XCTAssertThrowsError(try policy.validate(Fx.req(now: now, exp: now - 6_000), nowMs: now))
        try policy.validate(Fx.req(now: now, exp: now - 1_000), nowMs: now) // kichik soat farqi
        try policy.validate(Fx.req(now: now, exp: now + 120_000), nowMs: now)
        XCTAssertThrowsError(try policy.validate(Fx.req(now: now, exp: now + 120_001), nowMs: now))
    }

    func testAllContractTypesAreAllowed() {
        // Aniq son drift testida (center signer-policy-drift.spec.ts); bu yerda faqat takrorsizlik va 6.10 turi.
        XCTAssertEqual(Set(SigningPolicy.commandTypes).count, SigningPolicy.commandTypes.count)
        XCTAssertTrue(SigningPolicy.commandTypes.contains("project.scan"))
    }

    func testSessionResumeAndCloseTypesAreAllowed() {
        // 6.14: allow-list'da bo'lmasa markaz buyruqlari `signer_policy_violation` bilan rad etilardi.
        for t in ["session.resume", "session.close"] {
            XCTAssertTrue(SigningPolicy.commandTypes.contains(t), t)
        }
    }

    func testDeployAndCheckpointTypesAreAllowed() throws {
        // 6.5 deploy va 6.9 checkpoint: allow-list'da bo'lmasa markaz buyruqlari `signer_policy_violation` bilan rad etilardi.
        for t in ["deploy.inspect", "deploy.run", "deploy.rollback", "git.checkpoint", "git.checkpoint_list", "git.checkpoint_restore"] {
            XCTAssertTrue(SigningPolicy.commandTypes.contains(t), t)
        }
    }
}

final class RateLimiterTests: XCTestCase {
    func testWindowSlides() {
        let l = RateLimiter()
        for i in 0..<3 { XCTAssertTrue(l.allow("k", limit: 3, windowMs: 1000, now: Int64(i))) }
        XCTAssertFalse(l.allow("k", limit: 3, windowMs: 1000, now: 500))
        XCTAssertTrue(l.allow("k", limit: 3, windowMs: 1000, now: 1001))
    }

    func testAllowAllIsAtomic() {
        let l = RateLimiter()
        XCTAssertTrue(l.allow("b", limit: 1, windowMs: 1000, now: 0))
        XCTAssertFalse(l.allowAll([(key: "a", limit: 5, windowMs: 1000), (key: "b", limit: 1, windowMs: 1000)], now: 1))
        // "a" hisobga olinmagan bo'lishi kerak
        for _ in 0..<5 { XCTAssertTrue(l.allow("a", limit: 5, windowMs: 1000, now: 2)) }
    }
}
