import Foundation

/// `libs/contracts` CenterKeyRotation bilan bir xil JSON shakli (camelCase).
public struct Rotation: Codable, Equatable {
    public var previousPublicKey: String
    public var newPublicKey: String
    public var issuedAt: Int64
    public var expiresAt: Int64
    public var signature: String
}

/// Markaz kalitini aylantirish e'lonlari (OCHIQ ma'lumot; maxfiy kalit emas). Mantiq center `center-key-rotation.ts` bilan bir xil.
public enum Rotations {
    public static func read(path: String, now: Int64) -> [Rotation] {
        guard let d = try? Data(contentsOf: URL(fileURLWithPath: path)), let arr = try? JSONDecoder().decode([Rotation].self, from: d) else { return [] }
        return arr.filter { $0.expiresAt > now }
    }

    /// Oxirgi e'lon HOZIRGI kalitga olib borishi va zanjir uzluksiz bo'lishi shart; aks holda bo'sh (fail-safe).
    public static func validChain(_ r: [Rotation], currentPublicKey: String) -> [Rotation] {
        guard let last = r.last, last.newPublicKey == currentPublicKey else { return [] }
        var start = r.count - 1
        while start > 0 && r[start - 1].newPublicKey == r[start].previousPublicKey { start -= 1 }
        return Array(r[start...])
    }

    public static func write(_ r: [Rotation], to path: String) throws {
        let data = try JSONEncoder().encode(r)
        guard FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw SignerError("internal", "cannot write rotations file")
        }
    }

    /// Yuklashdagi tiklash: `.tmp` qolgan bo'lsa, faqat oxirgi e'lon YANGI (joriy) kalitga ishora qilsa qabul qilinadi.
    public static func recover(path: String, currentPublicKey: String) {
        let tmp = path + ".tmp"
        guard FileManager.default.fileExists(atPath: tmp) else { return }
        if let d = try? Data(contentsOf: URL(fileURLWithPath: tmp)), let arr = try? JSONDecoder().decode([Rotation].self, from: d),
           arr.last?.newPublicKey == currentPublicKey {
            try? FileManager.default.removeItem(atPath: path)
            try? FileManager.default.moveItem(atPath: tmp, toPath: path)
        } else {
            try? FileManager.default.removeItem(atPath: tmp)
        }
    }
}

public struct SignerError: Error, CustomStringConvertible {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
    public var description: String { "\(code): \(message)" }
}

public struct SignerPaths {
    public let stateDir: String
    public var runDir: String { stateDir + "/run" }
    public var authSecret: String { runDir + "/auth.secret" }
    public var logPath: String { stateDir + "/log/signatures.log" }
    public var rotationsPath: String { stateDir + "/rotations.json" }
    public var lockPath: String { stateDir + "/LOCK" }
    public init(stateDir: String) { self.stateDir = stateDir }
    public static var defaultStateDir: String { NSHomeDirectory() + "/.commander-signer" }

    public func prepare() throws {
        let fm = FileManager.default
        for d in [stateDir, runDir, stateDir + "/log"] {
            try fm.createDirectory(atPath: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: d)
        }
    }
}
