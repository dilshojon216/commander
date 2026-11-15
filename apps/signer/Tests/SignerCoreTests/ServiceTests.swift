import XCTest
import CryptoKit
@testable import SignerCore

final class ServiceTests: XCTestCase {
    func testSignsAndAuditsEverySignature() throws {
        let (s, paths, _, clock) = try Fx.service()
        let r = Fx.req(now: clock.now)
        let out = try s.signCommand(r, peer: "test")
        XCTAssertEqual(out.fingerprint, Fx.fingerprint)
        XCTAssertTrue(Fx.verify(sig: out.sig, message: SigningPolicy.canonicalString(r), publicB64: Fx.pubB64))
        let log = try String(contentsOfFile: paths.logPath, encoding: .utf8)
        XCTAssertTrue(log.contains("\"op\":\"sign_command\""))
        XCTAssertTrue(log.contains(Fx.command) && log.contains("project.refresh") && log.contains(Fx.device) && log.contains(String(repeating: "b", count: 64)))
        XCTAssertFalse(log.contains(out.sig), "imzoning o'zi logga tushmaydi")
        XCTAssertEqual(AuditLog.verify(path: paths.logPath).brokenAt, nil)
    }

    func testLockFileRefusesSigningAndRotationButNotInfo() throws {
        let (s, paths, _, clock) = try Fx.service()
        FileManager.default.createFile(atPath: paths.lockPath, contents: Data())
        XCTAssertThrowsError(try s.signCommand(Fx.req(now: clock.now), peer: "t")) { XCTAssertEqual(($0 as? SignerError)?.code, "locked") }
        XCTAssertThrowsError(try s.rotate(overlapDays: 30, peer: "t")) { XCTAssertEqual(($0 as? SignerError)?.code, "locked") }
        XCTAssertEqual(try s.info().fingerprint, Fx.fingerprint)
        try FileManager.default.removeItem(atPath: paths.lockPath)
        XCTAssertNoThrow(try s.signCommand(Fx.req(now: clock.now), peer: "t"))
        XCTAssertTrue(try String(contentsOfFile: paths.logPath, encoding: .utf8).contains("denied:locked"))
    }

    func testPolicyViolationIsDeniedAndLogged() throws {
        let (s, paths, _, clock) = try Fx.service()
        XCTAssertThrowsError(try s.signCommand(Fx.req(now: clock.now, type: "rm.rf"), peer: "t")) { XCTAssertEqual(($0 as? SignerError)?.code, "policy_violation") }
        XCTAssertTrue(try String(contentsOfFile: paths.logPath, encoding: .utf8).contains("denied:policy_violation"))
    }

    func testRateLimitPerDeviceAndGlobal() throws {
        var lim = SignerLimits(); lim.perDevicePerMinute = 3; lim.globalPerMinute = 5
        let (s, _, _, clock) = try Fx.service(limits: lim)
        for _ in 0..<3 { XCTAssertNoThrow(try s.signCommand(Fx.req(now: clock.now), peer: "t")) }
        XCTAssertThrowsError(try s.signCommand(Fx.req(now: clock.now), peer: "t")) { XCTAssertEqual(($0 as? SignerError)?.code, "rate_limited") }
        let other = "323e4567-e89b-42d3-a456-426614174002"
        XCTAssertNoThrow(try s.signCommand(Fx.req(now: clock.now, device: other), peer: "t"))
        XCTAssertNoThrow(try s.signCommand(Fx.req(now: clock.now, device: other), peer: "t"))
        XCTAssertThrowsError(try s.signCommand(Fx.req(now: clock.now, device: other), peer: "t")) { XCTAssertEqual(($0 as? SignerError)?.code, "rate_limited") }
        clock.now += 61_000
        XCTAssertNoThrow(try s.signCommand(Fx.req(now: clock.now), peer: "t"))
    }

    func testSignatureWithheldWhenAuditLogCannotBeWritten() throws {
        let (s, paths, _, clock) = try Fx.service()
        _ = paths
        s.auditForTests.simulateWriteFailure = true
        XCTAssertThrowsError(try s.signCommand(Fx.req(now: clock.now), peer: "t")) { XCTAssertEqual(($0 as? SignerError)?.code, "log_failed") }
    }

    func testMissingKeyFailsClosed() throws {
        let (s, _, _, clock) = try Fx.service(store: MemoryKeyStore())
        XCTAssertThrowsError(try s.signCommand(Fx.req(now: clock.now), peer: "t")) { XCTAssertEqual(($0 as? SignerError)?.code, "key_missing") }
        XCTAssertThrowsError(try s.info())
    }

    func testRotationGeneratesNewKeyInsideSignerAndChainVerifiesWithOldKey() throws {
        let (s, paths, ks, clock) = try Fx.service()
        let r = try s.rotate(overlapDays: 30, peer: "t")
        XCTAssertEqual(r.previousFingerprint, Fx.fingerprint)
        XCTAssertNotEqual(r.newFingerprint, Fx.fingerprint)
        let rot = r.rotation
        XCTAssertEqual(rot.previousPublicKey, Fx.pubB64)
        XCTAssertEqual(rot.expiresAt, clock.now + 30 * 86_400_000)
        let msg = SigningPolicy.rotationString(previousPublicKey: rot.previousPublicKey, newPublicKey: rot.newPublicKey, issuedAt: rot.issuedAt, expiresAt: rot.expiresAt)
        XCTAssertTrue(Fx.verify(sig: rot.signature, message: msg, publicB64: Fx.pubB64), "e'lon ESKI kalit bilan imzolangan")
        // yangi kalit endi imzolaydi
        let i = try s.info()
        XCTAssertEqual(i.publicKey, rot.newPublicKey)
        XCTAssertEqual(i.rotations, [rot])
        let req = Fx.req(now: clock.now)
        let sig = try s.signCommand(req, peer: "t").sig
        XCTAssertTrue(Fx.verify(sig: sig, message: SigningPolicy.canonicalString(req), publicB64: rot.newPublicKey))
        XCTAssertFalse(Fx.verify(sig: sig, message: SigningPolicy.canonicalString(req), publicB64: Fx.pubB64))
        XCTAssertNotEqual(try ks.loadSeed(), Fx.seed)
        XCTAssertTrue(FileManager.default.fileExists(atPath: paths.rotationsPath))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.rotationsPath + ".tmp"))
        // ikkinchi aylantirish: zanjir uzluksiz
        let r2 = try s.rotate(overlapDays: 30, peer: "t")
        XCTAssertEqual(try s.info().rotations.map(\.newPublicKey), [rot.newPublicKey, r2.newPublicKey])
        // limit
        XCTAssertThrowsError(try s.rotate(overlapDays: 30, peer: "t")) { XCTAssertEqual(($0 as? SignerError)?.code, "rate_limited") }
    }

    func testExpiredRotationsAreNotAnnounced() throws {
        let (s, _, _, clock) = try Fx.service()
        _ = try s.rotate(overlapDays: 1, peer: "t")
        clock.now += 2 * 86_400_000
        XCTAssertEqual(try s.info().rotations, [])
    }

    func testRotationRecoveryKeepsTmpOnlyIfNewKeyIsCurrent() throws {
        let (s, paths, _, clock) = try Fx.service()
        let r = try s.rotate(overlapDays: 5, peer: "t")
        // tmp = oxirgi e'lon yangi (joriy) kalitga ishora qiladi -> tiklanadi
        try Rotations.write([r.rotation], to: paths.rotationsPath + ".tmp")
        try FileManager.default.removeItem(atPath: paths.rotationsPath)
        s.recoverRotationsIfNeeded()
        XCTAssertEqual(try s.info().rotations, [r.rotation])
        // tmp boshqa kalitga ishora qiladi -> tashlanadi
        var bogus = r.rotation; bogus.newPublicKey = Fx.pubB64
        try Rotations.write([bogus], to: paths.rotationsPath + ".tmp")
        s.recoverRotationsIfNeeded()
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.rotationsPath + ".tmp"))
        XCTAssertEqual(try s.info().rotations, [r.rotation])
        _ = clock
    }

    func testRotateRejectsBadOverlap() throws {
        let (s, _, _, _) = try Fx.service()
        XCTAssertThrowsError(try s.rotate(overlapDays: 0, peer: "t"))
        XCTAssertThrowsError(try s.rotate(overlapDays: 366, peer: "t"))
    }

    // MARK: JSON qatlami

    func testHandleSignAndErrors() throws {
        let (s, _, _, clock) = try Fx.service()
        func call(_ o: [String: Any]) -> [String: Any] { s.handle(try! JSONSerialization.data(withJSONObject: o), peer: "t") }
        let ok = call(["id": "1", "op": "sign_command", "deviceId": Fx.device, "commandId": Fx.command, "type": "project.refresh", "nonce": String(repeating: "A", count: 43), "expiresAt": clock.now + 60_000, "payloadSha256": String(repeating: "b", count: 64)])
        XCTAssertEqual(ok["ok"] as? Bool, true); XCTAssertEqual(ok["id"] as? String, "1"); XCTAssertNotNil(ok["sig"])
        XCTAssertEqual(call(["op": "nope"])["code"] as? String, "bad_request")
        XCTAssertEqual(call(["op": "sign_command", "deviceId": Fx.device])["code"] as? String, "bad_request")
        XCTAssertEqual(call(["op": "sign_command", "deviceId": Fx.device, "commandId": Fx.command, "type": "project.refresh", "nonce": String(repeating: "A", count: 43), "expiresAt": true, "payloadSha256": String(repeating: "b", count: 64)])["code"] as? String, "bad_request")
        XCTAssertEqual(s.handle(Data("not json".utf8), peer: "t")["code"] as? String, "bad_request")
        let info = call(["op": "info"])
        XCTAssertEqual(info["publicKey"] as? String, Fx.pubB64)
        XCTAssertEqual(call(["op": "rotate", "overlapDays": 1000])["code"] as? String, "policy_violation")
    }
}

final class AuditLogTests: XCTestCase {
    func testChainDetectsTamperingAndResumesAfterReopen() throws {
        let p = Fx.tmpDir() + "/a.log"
        AuditLog.setAppendOnlyFlag = true
        defer { chflags(p, 0); AuditLog.setAppendOnlyFlag = false }
        var log: AuditLog? = try AuditLog(path: p)
        try log!.append([("op", "x"), ("n", "1")]); try log!.append([("op", "x"), ("n", "2")])
        log = nil
        let again = try AuditLog(path: p)
        try again.append([("op", "x"), ("n", "3")])
        XCTAssertEqual(AuditLog.verify(path: p).lines, 3); XCTAssertNil(AuditLog.verify(path: p).brokenAt)
        // UF_APPEND: chflags nouappend'siz o'zgartirib bo'lmaydi
        XCTAssertThrowsError(try Data().write(to: URL(fileURLWithPath: p)))
        var text = try String(contentsOfFile: p, encoding: .utf8)
        text = text.replacingOccurrences(of: "\"n\":\"2\"", with: "\"n\":\"9\"")
        chflags(p, 0)
        try text.write(toFile: p, atomically: false, encoding: .utf8)
        XCTAssertEqual(AuditLog.verify(path: p).brokenAt, 2)
    }
}

final class ImportBackupTests: XCTestCase {
    func testPemImportMatchesNodeKey() throws {
        let seed = try KeyImport.seed(fromPKCS8PEM: Fx.pem)
        XCTAssertEqual(seed, Fx.seed)
        let p = try KeyImport.publicKey(seed: seed)
        XCTAssertEqual(p.b64, Fx.pubB64); XCTAssertEqual(p.fingerprint, Fx.fingerprint)
        XCTAssertThrowsError(try KeyImport.seed(fromPKCS8PEM: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"))
        XCTAssertThrowsError(try KeyImport.seed(fromPKCS8PEM: "garbage"))
    }

    func testBackupRoundTripWrongPassphraseAndTamper() throws {
        let rot = Rotation(previousPublicKey: "a", newPublicKey: "b", issuedAt: 1, expiresAt: 2, signature: "s")
        let blob = try Backup.seal(seed: Fx.seed, rotations: [rot], passphrase: "correct horse battery", iterations: 100_000)
        let text = String(data: blob, encoding: .utf8)!
        XCTAssertFalse(text.contains(Enc.b64url(Fx.seed)), "urug' ochiq yozilmaydi")
        let o = try Backup.open(blob, passphrase: "correct horse battery")
        XCTAssertEqual(o.seed, Fx.seed); XCTAssertEqual(o.fingerprint, Fx.fingerprint); XCTAssertEqual(o.rotations, [rot])
        XCTAssertThrowsError(try Backup.open(blob, passphrase: "wrong passphrase!!"))
        XCTAssertThrowsError(try Backup.open(Data(text.replacingOccurrences(of: Fx.fingerprint, with: "0000000000000000").utf8), passphrase: "correct horse battery"), "AAD fingerprint'ga bog'langan")
        XCTAssertThrowsError(try Backup.seal(seed: Fx.seed, rotations: [], passphrase: "short"))
    }

    func testFileKeyStoreAndImportRefusesDifferentKey() throws {
        let ks = MemoryKeyStore(seed: Fx.seed)
        XCTAssertThrowsError(try ks.storeSeed(Enc.randomBytes(32), replace: false)) { XCTAssertEqual($0 as? KeyStoreError, .exists) }
    }
}
