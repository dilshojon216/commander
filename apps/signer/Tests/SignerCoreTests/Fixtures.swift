import Foundation
import CryptoKit
@testable import SignerCore

/// Faqat testlar uchun deterministik kalit (urug' 00..1f). Production kaliti EMAS.
enum Fx {
    static let seed = Data((0..<32).map { UInt8($0) })
    static let pubB64 = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"
    static let fingerprint = "56475aa75463474c"
    static let pem = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f\n-----END PRIVATE KEY-----\n"
    /// Node (crypto.sign) bilan mustaqil hisoblangan imzo: Ed25519 deterministik, ikki tilda bir xil bo'lishi shart.
    static let goldenSig = "kdHAsgpxDaZLVOSlC4sQ8GyAi4Qu3FMXVF-l7CzBMTeT3KjQmAfo76rdKkSyuWTu4oRCl9B6jtkPSew2Mi1kDQ"
    static let device = "123e4567-e89b-42d3-a456-426614174000"
    static let command = "223e4567-e89b-42d3-a456-426614174001"

    static func req(now: Int64, type: String = "project.refresh", exp: Int64? = nil, device: String = Fx.device) -> CommandSignRequest {
        CommandSignRequest(deviceId: device, commandId: command, type: type, nonce: String(repeating: "A", count: 43), expiresAt: exp ?? now + 60_000, payloadSha256: String(repeating: "b", count: 64))
    }

    static func tmpDir() -> String {
        AuditLog.setAppendOnlyFlag = false
        let d = NSTemporaryDirectory() + "signer-test-" + UUID().uuidString
        try! FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }

    final class Clock { var now: Int64 = 1_900_000_000_000 - 30_000; func tick() -> Int64 { now } }

    static func service(clock: Clock = Clock(), store: KeyStore? = nil, limits: SignerLimits = SignerLimits(), logPath: String? = nil) throws -> (SignerService, SignerPaths, KeyStore, Clock) {
        let dir = tmpDir()
        let paths = SignerPaths(stateDir: dir)
        try paths.prepare()
        let ks = store ?? MemoryKeyStore(seed: seed)
        let audit = try AuditLog(path: logPath ?? paths.logPath)
        let s = SignerService(keyStore: ks, paths: paths, audit: audit, limits: limits, clock: { clock.now })
        return (s, paths, ks, clock)
    }

    static func verify(sig: String, message: String, publicB64: String) -> Bool {
        guard let raw = Enc.fromB64url(publicB64), let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: raw), let s = Enc.fromB64url(sig) else { return false }
        return pub.isValidSignature(s, for: Data(message.utf8))
    }
}
