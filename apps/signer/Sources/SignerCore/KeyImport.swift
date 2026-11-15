import Foundation
import CryptoKit
import CommonCrypto

public enum KeyImport {
    static let pkcs8Prefix: [UInt8] = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]

    /// Node `generateKeyPairSync('ed25519')` PKCS8 PEM'idan 32 baytli urug'. Boshqa shakl rad etiladi.
    public static func seed(fromPKCS8PEM pem: String) throws -> Data {
        let body = pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
        guard pem.contains("BEGIN PRIVATE KEY"), let der = Data(base64Encoded: body), der.count == 48, Array(der.prefix(16)) == pkcs8Prefix else {
            throw SignerError("bad_request", "not an Ed25519 PKCS8 PEM")
        }
        return der.suffix(32)
    }

    public static func publicKey(seed: Data) throws -> (b64: String, fingerprint: String) {
        let k = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        return (Enc.b64url(k.publicKey.rawRepresentation), Enc.fingerprint(rawPublicKey: k.publicKey.rawRepresentation))
    }
}

/// Egasi ishga tushiradigan shifrlangan zaxira (DR). Format: JSON, `COMMANDER-SIGNER-BACKUP-V1`.
/// KDF: PBKDF2-HMAC-SHA256 (600k), shifr: AES-256-GCM, AAD = `format|fingerprint`. Ochiq matn diskka tushmaydi.
public enum Backup {
    public static let format = "COMMANDER-SIGNER-BACKUP-V1"
    public static let defaultIterations = 600_000

    struct Envelope: Codable { var format: String; var fingerprint: String; var kdf: String; var iterations: Int; var salt: String; var nonce: String; var ciphertext: String; var createdAt: String }
    struct Payload: Codable { var seed: String; var rotations: [Rotation] }

    static func derive(_ pass: String, salt: Data, iterations: Int) throws -> SymmetricKey {
        var out = [UInt8](repeating: 0, count: 32)
        let pw = Array(pass.utf8)
        let rc = pw.withUnsafeBufferPointer { p in
            salt.withUnsafeBytes { s in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), UnsafeRawPointer(p.baseAddress!).assumingMemoryBound(to: Int8.self), pw.count,
                                     s.bindMemory(to: UInt8.self).baseAddress!, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations), &out, out.count)
            }
        }
        guard rc == kCCSuccess else { throw SignerError("internal", "KDF failed") }
        return SymmetricKey(data: out)
    }

    public static func seal(seed: Data, rotations: [Rotation], passphrase: String, iterations: Int = defaultIterations) throws -> Data {
        guard passphrase.count >= 12 else { throw SignerError("bad_request", "passphrase must be at least 12 characters") }
        let fp = try KeyImport.publicKey(seed: seed).fingerprint
        let salt = Enc.randomBytes(16)
        let key = try derive(passphrase, salt: salt, iterations: iterations)
        let payload = try JSONEncoder().encode(Payload(seed: Enc.b64url(seed), rotations: rotations))
        let box = try AES.GCM.seal(payload, using: key, authenticating: Data("\(format)|\(fp)".utf8))
        let env = Envelope(format: format, fingerprint: fp, kdf: "PBKDF2-HMAC-SHA256", iterations: iterations, salt: Enc.b64url(salt), nonce: Enc.b64url(Data(box.nonce)),
                           ciphertext: Enc.b64url(box.ciphertext + box.tag), createdAt: AuditLog.iso(nowMs()))
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try enc.encode(env)
    }

    public static func open(_ file: Data, passphrase: String) throws -> (seed: Data, rotations: [Rotation], fingerprint: String) {
        guard let env = try? JSONDecoder().decode(Envelope.self, from: file), env.format == format, (100_000...10_000_000).contains(env.iterations),
              let salt = Enc.fromB64url(env.salt), let nonce = Enc.fromB64url(env.nonce), let ct = Enc.fromB64url(env.ciphertext), ct.count > 16 else {
            throw SignerError("bad_request", "not a signer backup file")
        }
        let key = try derive(passphrase, salt: salt, iterations: env.iterations)
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
            let plain = try AES.GCM.open(box, using: key, authenticating: Data("\(format)|\(env.fingerprint)".utf8))
            let p = try JSONDecoder().decode(Payload.self, from: plain)
            guard let seed = Enc.fromB64url(p.seed), seed.count == 32, try KeyImport.publicKey(seed: seed).fingerprint == env.fingerprint else { throw SignerError("bad_request", "backup content is inconsistent") }
            return (seed, p.rotations, env.fingerprint)
        } catch let e as SignerError { throw e } catch { throw SignerError("bad_request", "wrong passphrase or corrupted backup") }
    }
}
