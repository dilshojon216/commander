import Foundation

/// Imzolash siyosati: faqat to'g'ri shakldagi `COMMANDER-CMD-V1` buyruqlari. Imzolovchi kanonik satrni O'ZI quradi
/// (markaz xom satr yubormaydi), shuning uchun boshqa turdagi (masalan, aylantirish e'loni) satrni imzolatib bo'lmaydi.
public struct CommandSignRequest: Equatable {
    public var deviceId: String
    public var commandId: String
    public var type: String
    public var nonce: String
    public var expiresAt: Int64
    public var payloadSha256: String
    public init(deviceId: String, commandId: String, type: String, nonce: String, expiresAt: Int64, payloadSha256: String) {
        self.deviceId = deviceId; self.commandId = commandId; self.type = type; self.nonce = nonce; self.expiresAt = expiresAt; self.payloadSha256 = payloadSha256
    }
}

public enum PolicyViolation: Error, Equatable, CustomStringConvertible {
    case badField(String)
    case unknownType(String)
    case expiryOutOfRange(String)
    public var description: String {
        switch self {
        case .badField(let f): return "field '\(f)' is malformed"
        case .unknownType(let t): return "command type '\(t)' is not allowed"
        case .expiryOutOfRange(let m): return "expiresAt \(m)"
        }
    }
}

public struct SigningPolicy {
    /// libs/contracts COMMAND_TYPES bilan bir xil bo'lishi shart (drift testi: apps/center/src/commands/signer-policy-drift.spec.ts).
    public static let commandTypes: [String] = [
        "session.start", "session.prompt", "session.stop", "session.set_mode", "session.remote_control", "session.resume", "session.close",
        "project.refresh", "project.read_md", "project.append_tasks", "project.summarize", "project.diff", "project.open_pr", "project.ci_status", "project.scan",
        "config.capture", "config.apply", "config.rollback",
        "assistant.ask",
        "logs.tail",
        "deploy.inspect", "deploy.run", "deploy.rollback",
        "git.checkpoint", "git.checkpoint_list", "git.checkpoint_restore",
    ]
    public static let version = "COMMANDER-CMD-V1"

    public var allowedTypes: Set<String>
    /// Buyruq muddati: hozirdan keyin shuncha ms dan oshmasin (center 60 s ishlatadi).
    public var maxTtlMs: Int64
    /// Soat farqi uchun kichik tolerantlik (allaqachon o'tib ketgan muddat rad etiladi).
    public var skewMs: Int64

    public init(allowedTypes: Set<String> = Set(SigningPolicy.commandTypes), maxTtlMs: Int64 = 120_000, skewMs: Int64 = 5_000) {
        self.allowedTypes = allowedTypes; self.maxTtlMs = maxTtlMs; self.skewMs = skewMs
    }

    static func matches(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }
    static let uuid = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

    public func validate(_ r: CommandSignRequest, nowMs: Int64) throws {
        guard Self.matches(r.deviceId, Self.uuid) else { throw PolicyViolation.badField("deviceId") }
        guard Self.matches(r.commandId, Self.uuid) else { throw PolicyViolation.badField("commandId") }
        guard allowedTypes.contains(r.type) else { throw PolicyViolation.unknownType(String(r.type.prefix(40))) }
        guard Self.matches(r.nonce, "^[A-Za-z0-9_-]{43}$") else { throw PolicyViolation.badField("nonce") }
        guard Self.matches(r.payloadSha256, "^[0-9a-fA-F]{64}$") else { throw PolicyViolation.badField("payloadSha256") }
        if r.expiresAt <= nowMs - skewMs { throw PolicyViolation.expiryOutOfRange("is already in the past") }
        if r.expiresAt > nowMs + maxTtlMs { throw PolicyViolation.expiryOutOfRange("is too far in the future (max \(maxTtlMs) ms)") }
    }

    /// `buildCommandSigString` (libs/contracts) bilan bayt-bayt bir xil.
    public static func canonicalString(_ r: CommandSignRequest) -> String {
        [version, r.deviceId.lowercased(), r.commandId.lowercased(), r.type, r.nonce, String(r.expiresAt), r.payloadSha256.lowercased()].joined(separator: "\n")
    }

    /// `buildCenterKeyRotationString` bilan bir xil.
    public static func rotationString(previousPublicKey: String, newPublicKey: String, issuedAt: Int64, expiresAt: Int64) -> String {
        ["COMMANDER-CENTER-KEY-ROTATION-V1", previousPublicKey, newPublicKey, String(issuedAt), String(expiresAt)].joined(separator: "\n")
    }
}
