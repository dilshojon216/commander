import CommanderContracts
import Foundation
import XCTest

/// clients/fixtures/*.json (jonli center'dan olingan, tozalangan). Fayllar o'zgartirilmaydi:
/// variantlar JSON darajasida maydonlarni almashtirib yasaladi (shunda tiplar baribir generatsiya qilingan dekoderdan o'tadi).
enum Fixtures {
    static let dir: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // MenuBarCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // menubar
        .deletingLastPathComponent() // apps
        .deletingLastPathComponent() // repo
        .appendingPathComponent("clients/fixtures")

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: dir.appendingPathComponent("\(name).json"))
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: data(name))
    }

    static func object(_ name: String) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: data(name)) as! [String: Any]
    }

    static func patched<T: Decodable>(_ type: T.Type, _ base: [String: Any], _ patch: [String: Any?]) throws -> T {
        var o = base
        for (k, v) in patch { o[k] = v ?? NSNull() }
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: o))
    }

    static func iso(_ d: Date) -> String { ContractDates.format(d) }

    /// approval.json asosida pending (yoki boshqa holatdagi) approval.
    static func approval(id: String = "64979d91-0f09-4549-8058-ee5a0a4367e9", status: String = "pending", kind: String = "tool",
                         plan: String? = nil, deadline: Date = Date().addingTimeInterval(240),
                         requestedAt: Date = Date().addingTimeInterval(-10)) throws -> ApprovalDto {
        try patched(ApprovalDto.self, object("approval"), [
            "id": id, "status": status, "kind": kind, "plan": plan,
            "behavior": status == "pending" ? nil : "allow",
            "decidedAt": nil, "decidedByDeviceId": nil, "resolvedAt": nil,
            "deadline": iso(deadline), "requestedAt": iso(requestedAt),
        ])
    }

    /// sessions.json dagi birinchi sessiya, holati almashtirilgan.
    static func session(id: String? = nil, status: String, project: String? = nil, stale: Bool = false) throws -> SessionDto {
        let items = try object("sessions")["items"] as! [[String: Any]]
        var patch: [String: Any?] = ["status": status, "staleSince": stale ? "2026-11-14T03:00:00.000Z" : nil]
        if let id { patch["id"] = id }
        if let project { patch["projectName"] = project }
        return try patched(SessionDto.self, items[0], patch)
    }

    /// limits.json dagi oyna, maydonlari almashtirilgan.
    static func window(_ key: String = "sevenDay", _ patch: [String: Any?]) throws -> LimitWindowView {
        let w = try object("limits")[key] as! [String: Any]
        return try patched(LimitWindowView.self, w, patch)
    }

    static func message(_ name: String) throws -> ServerToClientMessage {
        try decode(ServerToClientMessage.self, "ws/\(name)")
    }

    static func envelope(type: String, payload: [String: Any]) throws -> ServerToClientMessage {
        let o: [String: Any] = ["v": 1, "id": UUID().uuidString.lowercased(), "type": type, "ts": 1_763_092_800_000, "payload": payload]
        return try JSONDecoder().decode(ServerToClientMessage.self, from: JSONSerialization.data(withJSONObject: o))
    }

    static func json<T: Encodable>(_ v: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(v))
    }
}
