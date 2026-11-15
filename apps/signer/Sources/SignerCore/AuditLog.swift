import Foundation
import CryptoKit
import Darwin

/// Faqat-qo'shiladigan imzo logi (JSONL) + xesh zanjiri: har qator oldingi qator xeshini o'z ichiga oladi
/// (`prev`), `hash` = sha256(qator `hash`siz). O'zgartirish/o'chirish `verify` da topiladi. Fayl `O_APPEND` bilan ochiladi va
/// yaratilgach `UF_APPEND` (chflags uappend) o'rnatiladi. Log yozilmasa imzo BERILMAYDI (fail-closed).
public final class AuditLog {
    public enum LogError: Error { case cannotOpen(String), cannotWrite(String) }

    private let path: String
    private var fd: Int32 = -1
    private var lastHash = String(repeating: "0", count: 64)
    private var seq: Int64 = 0
    private let lock = NSLock()
    /// Faqat testlar: yozish xatosini taqlid qiladi (imzo ushlab qolinishini tekshirish uchun).
    var simulateWriteFailure = false
    /// Testlar tmp katalogni tozalashi uchun o'chirib qo'yadi (production: doim yoqilgan).
    nonisolated(unsafe) static var setAppendOnlyFlag = true

    public init(path: String) throws {
        self.path = path
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let existed = FileManager.default.fileExists(atPath: path)
        fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
        guard fd >= 0 else { throw LogError.cannotOpen(String(cString: strerror(errno))) }
        if existed { (lastHash, seq) = Self.tail(path: path) }
        else if Self.setAppendOnlyFlag { _ = fchflags(fd, UInt32(UF_APPEND)) }
    }

    deinit { if fd >= 0 { close(fd) } }

    static func tail(path: String) -> (String, Int64) {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8), let line = text.split(separator: "\n").last,
              let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let h = obj["hash"] as? String, let s = obj["seq"] as? Int64 ?? (obj["seq"] as? Int).map(Int64.init) else {
            return (String(repeating: "0", count: 64), 0)
        }
        return (h, s)
    }

    static func jsonString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes])
        let arr = String(data: data ?? Data("[\"\"]".utf8), encoding: .utf8) ?? "[\"\"]"
        return String(arr.dropFirst().dropLast())
    }

    /// Maydonlar tartibi qat'iy (xesh deterministik). Qiymatlar matn.
    @discardableResult
    public func append(_ fields: [(String, String)]) throws -> String {
        lock.lock(); defer { lock.unlock() }
        if simulateWriteFailure { throw LogError.cannotWrite("simulated") }
        seq += 1
        var parts = ["\"seq\":\(seq)", "\"ts\":\(Self.jsonString(Self.iso(nowMs())))"]
        for (k, v) in fields { parts.append("\(Self.jsonString(k)):\(Self.jsonString(v))") }
        parts.append("\"prev\":\(Self.jsonString(lastHash))")
        let body = "{" + parts.joined(separator: ",")
        let hash = Enc.hex(SHA256.hash(data: Data((body + "}").utf8)))
        let line = body + ",\"hash\":\"\(hash)\"}\n"
        let bytes = Array(line.utf8)
        var off = 0
        while off < bytes.count {
            let n = bytes[off...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            if n < 0 { if errno == EINTR { continue }; seq -= 1; throw LogError.cannotWrite(String(cString: strerror(errno))) }
            off += n
        }
        if fsync(fd) != 0 { throw LogError.cannotWrite(String(cString: strerror(errno))) }
        lastHash = hash
        return hash
    }

    public static func iso(_ ms: Int64) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    /// Zanjirni tekshiradi: (qatorlar soni, birinchi buzilgan qator raqami yoki nil).
    public static func verify(path: String) -> (lines: Int, brokenAt: Int?) {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return (0, nil) }
        var prev = String(repeating: "0", count: 64)
        var n = 0
        for raw in text.split(separator: "\n", omittingEmptySubsequences: true) {
            n += 1
            let line = String(raw)
            guard let r = line.range(of: ",\"hash\":\"", options: .backwards), line.hasSuffix("\"}") else { return (n, n) }
            let body = String(line[..<r.lowerBound])
            let hash = String(line[r.upperBound...].dropLast(2))
            guard body.contains("\"prev\":\"\(prev)\""), Enc.hex(SHA256.hash(data: Data((body + "}").utf8))) == hash else { return (n, n) }
            prev = hash
        }
        return (n, nil)
    }
}
