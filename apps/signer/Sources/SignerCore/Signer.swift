import Foundation
import CryptoKit

public struct InfoResult: Equatable {
    public let publicKey: String
    public let fingerprint: String
    public let rotations: [Rotation]
}

/// Imzolovchining asosiy mantig'i (soket'dan mustaqil: testlanadi). Maxfiy urug' faqat imzolash paytida xotiraga o'qiladi.
public final class SignerService {
    private let keyStore: KeyStore
    private let paths: SignerPaths
    private let audit: AuditLog
    var auditForTests: AuditLog { audit }
    public var policy: SigningPolicy
    public var limits: SignerLimits
    private let limiter = RateLimiter()
    private let clock: () -> Int64
    private let lock = NSLock()
    private let bootId = Enc.hex(Enc.randomBytes(8))

    public init(keyStore: KeyStore, paths: SignerPaths, audit: AuditLog, policy: SigningPolicy = SigningPolicy(), limits: SignerLimits = SignerLimits(), clock: @escaping () -> Int64 = nowMs) {
        self.keyStore = keyStore; self.paths = paths; self.audit = audit; self.policy = policy; self.limits = limits; self.clock = clock
    }

    // MARK: kalit

    private func withKey<T>(_ body: (Curve25519.Signing.PrivateKey) throws -> T) throws -> T {
        var seed: Data
        do {
            guard let s = try keyStore.loadSeed() else { throw SignerError("key_missing", "no signing key in the key store (run import/generate)") }
            seed = s
        } catch let e as SignerError { throw e } catch { throw SignerError("key_unavailable", "\(error)") }
        defer { seed.resetBytes(in: 0..<seed.count) }
        guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else { throw SignerError("key_unavailable", "stored key is invalid") }
        return try body(key)
    }

    /// Golden-vector va testlar uchun: urug' + kanonik satr -> base64url imzo.
    public static func sign(seed: Data, message: String) throws -> String {
        let k = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        return Enc.b64url(try k.signature(for: Data(message.utf8)))
    }

    public static func publicB64(_ k: Curve25519.Signing.PrivateKey) -> String { Enc.b64url(k.publicKey.rawRepresentation) }

    public func recoverRotationsIfNeeded() {
        if let pub = try? withKey({ Self.publicB64($0) }) { Rotations.recover(path: paths.rotationsPath, currentPublicKey: pub) }
    }

    public func info() throws -> InfoResult {
        let now = clock()
        let pub = try withKey { Self.publicB64($0) }
        let chain = Rotations.validChain(Rotations.read(path: paths.rotationsPath, now: now), currentPublicKey: pub)
        return InfoResult(publicKey: pub, fingerprint: Enc.fingerprint(rawPublicKey: Enc.fromB64url(pub)!), rotations: chain)
    }

    public var isLocked: Bool { FileManager.default.fileExists(atPath: paths.lockPath) }

    // MARK: audit

    private func record(_ op: String, _ result: String, _ extra: [(String, String)] = [], peer: String, fp: String = "") throws {
        try audit.append([("op", op), ("result", result)] + extra + [("keyFp", fp), ("peer", peer)])
    }

    /// Rad etishlar ham yoziladi (daqiqasiga cheklangan: spam logni to'ldirmasin).
    private func denied(_ op: String, _ code: String, _ extra: [(String, String)], peer: String) -> SignerError {
        if limiter.allow("deny-log", limit: 60, windowMs: 60_000, now: clock()) { try? record(op, "denied:\(code)", extra, peer: peer) }
        return SignerError(code, "")
    }

    // MARK: imzolash

    public func signCommand(_ r: CommandSignRequest, peer: String) throws -> (sig: String, fingerprint: String) {
        lock.lock(); defer { lock.unlock() }
        let now = clock()
        let extra: [(String, String)] = [("commandId", r.commandId), ("type", String(r.type.prefix(40))), ("deviceId", r.deviceId), ("payloadSha256", r.payloadSha256), ("expiresAt", String(r.expiresAt))]
        if isLocked { _ = denied("sign_command", "locked", extra, peer: peer); throw SignerError("locked", "the signer lock file is present (manual kill switch)") }
        do { try policy.validate(r, nowMs: now) } catch {
            _ = denied("sign_command", "policy_violation", extra, peer: peer)
            throw SignerError("policy_violation", "\(error)")
        }
        let ok = limiter.allowAll([
            (key: "g-min", limit: limits.globalPerMinute, windowMs: 60_000),
            (key: "g-hour", limit: limits.globalPerHour, windowMs: 3_600_000),
            (key: "d-\(r.deviceId.lowercased())", limit: limits.perDevicePerMinute, windowMs: 60_000),
        ], now: now)
        if !ok { _ = denied("sign_command", "rate_limited", extra, peer: peer); throw SignerError("rate_limited", "signing rate limit exceeded") }
        let message = Data(SigningPolicy.canonicalString(r).utf8)
        let (sig, fp): (Data, String) = try withKey { key in
            (try key.signature(for: message), Enc.fingerprint(rawPublicKey: key.publicKey.rawRepresentation))
        }
        do { try record("sign_command", "ok", extra, peer: peer, fp: fp) } catch {
            throw SignerError("log_failed", "audit log write failed; signature withheld")
        }
        return (Enc.b64url(sig), fp)
    }

    // MARK: aylantirish (yangi kalit imzolovchi ichida yaratiladi)

    public struct RotateResult { public let previousFingerprint: String; public let newFingerprint: String; public let newPublicKey: String; public let rotation: Rotation }

    public func rotate(overlapDays: Int, peer: String) throws -> RotateResult {
        lock.lock(); defer { lock.unlock() }
        let now = clock()
        if isLocked { _ = denied("rotate", "locked", [], peer: peer); throw SignerError("locked", "the signer lock file is present") }
        guard (1...365).contains(overlapDays) else { throw SignerError("policy_violation", "overlapDays must be an integer 1-365") }
        guard limiter.allow("rotate", limit: limits.rotatePerHour, windowMs: 3_600_000, now: now) else {
            _ = denied("rotate", "rate_limited", [], peer: peer); throw SignerError("rate_limited", "rotation rate limit exceeded")
        }
        let newKey = Curve25519.Signing.PrivateKey()
        let newPub = Self.publicB64(newKey)
        var newSeed = newKey.rawRepresentation
        defer { newSeed.resetBytes(in: 0..<newSeed.count) }

        let (prevPub, rotation): (String, Rotation) = try withKey { old in
            let prev = Self.publicB64(old)
            let issued = now, expires = now + Int64(overlapDays) * 86_400_000
            let msg = Data(SigningPolicy.rotationString(previousPublicKey: prev, newPublicKey: newPub, issuedAt: issued, expiresAt: expires).utf8)
            let sig = Enc.b64url(try old.signature(for: msg))
            return (prev, Rotation(previousPublicKey: prev, newPublicKey: newPub, issuedAt: issued, expiresAt: expires, signature: sig))
        }
        let prevFp = Enc.fingerprint(rawPublicKey: Enc.fromB64url(prevPub)!)
        let newFp = Enc.fingerprint(rawPublicKey: Enc.fromB64url(newPub)!)
        let chain = Rotations.validChain(Rotations.read(path: paths.rotationsPath, now: now), currentPublicKey: prevPub) + [rotation]
        // Tartib (qulashga chidamli): (1) e'lon .tmp, (2) Keychain'da kalit almashtiriladi, (3) .tmp -> rotations.json.
        let tmp = paths.rotationsPath + ".tmp"
        try Rotations.write(chain, to: tmp)
        do { try keyStore.storeSeed(newSeed, replace: true) } catch {
            try? FileManager.default.removeItem(atPath: tmp)
            throw SignerError("key_unavailable", "\(error)")
        }
        try? FileManager.default.removeItem(atPath: paths.rotationsPath)
        try FileManager.default.moveItem(atPath: tmp, toPath: paths.rotationsPath)
        do { try record("rotate", "ok", [("previousFp", prevFp), ("newFp", newFp), ("overlapDays", String(overlapDays))], peer: peer, fp: newFp) } catch {
            // Aylantirish allaqachon bajarilgan; log xatosi natijani bekor qila olmaydi: xabar beramiz.
            throw SignerError("log_failed", "key rotated (\(prevFp) -> \(newFp)) but the audit log write failed")
        }
        return RotateResult(previousFingerprint: prevFp, newFingerprint: newFp, newPublicKey: newPub, rotation: rotation)
    }

    // MARK: wire (JSON so'rov -> javob)

    public func handle(_ line: Data, peer: String) -> [String: Any] {
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let op = obj["op"] as? String else {
            return ["ok": false, "code": "bad_request", "message": "malformed request"]
        }
        var resp: [String: Any]
        do {
            switch op {
            case "info":
                let i = try info()
                resp = ["ok": true, "publicKey": i.publicKey, "fingerprint": i.fingerprint, "rotations": try Self.jsonArray(i.rotations), "locked": isLocked, "bootId": bootId]
            case "status":
                resp = ["ok": true, "locked": isLocked, "bootId": bootId, "keyPresent": ((try? keyStore.loadSeed()) ?? nil) != nil]
            case "sign_command":
                guard let t = obj["type"] as? String, let d = obj["deviceId"] as? String, let c = obj["commandId"] as? String,
                      let n = obj["nonce"] as? String, let p = obj["payloadSha256"] as? String, let e = (obj["expiresAt"] as? NSNumber), CFGetTypeID(e) != CFBooleanGetTypeID(),
                      e.doubleValue == e.doubleValue.rounded() else { throw SignerError("bad_request", "missing or invalid fields") }
                let r = try signCommand(CommandSignRequest(deviceId: d, commandId: c, type: t, nonce: n, expiresAt: e.int64Value, payloadSha256: p), peer: peer)
                resp = ["ok": true, "sig": r.sig, "fingerprint": r.fingerprint]
            case "rotate":
                guard let days = (obj["overlapDays"] as? NSNumber)?.intValue else { throw SignerError("bad_request", "overlapDays required") }
                let r = try rotate(overlapDays: days, peer: peer)
                resp = ["ok": true, "previousFingerprint": r.previousFingerprint, "newFingerprint": r.newFingerprint, "newPublicKey": r.newPublicKey, "rotation": try Self.jsonDict(r.rotation)]
            default:
                throw SignerError("bad_request", "unknown op")
            }
        } catch let e as SignerError {
            resp = ["ok": false, "code": e.code, "message": e.message]
        } catch {
            resp = ["ok": false, "code": "internal", "message": "internal error"]
        }
        if let id = obj["id"] as? String { resp["id"] = id }
        return resp
    }

    static func jsonDict(_ r: Rotation) throws -> [String: Any] {
        (try JSONSerialization.jsonObject(with: JSONEncoder().encode(r))) as? [String: Any] ?? [:]
    }
    static func jsonArray(_ r: [Rotation]) throws -> [[String: Any]] { try r.map(jsonDict) }
}
