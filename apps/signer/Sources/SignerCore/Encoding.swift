import Foundation
import CryptoKit

public enum Enc {
    public static func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    public static func fromB64url(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    public static func hex(_ d: some Sequence<UInt8>) -> String { d.map { String(format: "%02x", $0) }.joined() }

    public static func sha256Hex(_ s: String) -> String { hex(SHA256.hash(data: Data(s.utf8))) }

    /// Xom public key (32 bayt) fingerprint'i: sha256 birinchi 16 hex (center `fingerprintOfRaw` bilan bir xil).
    public static func fingerprint(rawPublicKey: Data) -> String { String(hex(SHA256.hash(data: rawPublicKey)).prefix(16)) }

    public static func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        let rc = d.withUnsafeMutableBytes { SecRandomCopyBytesShim($0.baseAddress!, n) }
        precondition(rc == 0, "random generator failed")
        return d
    }

    /// Doimiy vaqtli taqqoslash (HMAC tekshiruvi uchun).
    public static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }

    public static func hmac(key: Data, _ message: String) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: key)))
    }
}

@inline(__always) func SecRandomCopyBytesShim(_ p: UnsafeMutableRawPointer, _ n: Int) -> Int32 {
    // CryptoKit tasodifiy baytlar uchun: SystemRandomNumberGenerator (arc4random) kriptografik xavfsiz.
    var g = SystemRandomNumberGenerator()
    let buf = p.assumingMemoryBound(to: UInt8.self)
    for i in 0..<n { buf[i] = UInt8.random(in: 0...255, using: &g) }
    return 0
}

public func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
