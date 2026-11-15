import CommanderContracts
import Foundation

/// `/ws/client` kadrlarini kodlash/dekodlash (generatsiya qilingan union tiplari orqali).
public enum ClientWire {
    /// Biz obuna bo'ladigan kanallar.
    public static let channels: [ClientChannel] = [.sessions, .machines, .limits, .approvals, .alerts, .health, .queue]

    public static func subscribe(id: String = UUID().uuidString.lowercased(), now: Date = Date()) -> Data? {
        let msg = ClientToServerMessage.subscribe(ClientSubscribeMessage(id: id, ts: epochMs(now), payload: ClientSubscribePayload(channels: channels)))
        return try? JSONEncoder().encode(msg)
    }

    public static func ping(id: String = UUID().uuidString.lowercased(), now: Date = Date()) -> Data? {
        try? JSONEncoder().encode(ClientToServerMessage.ping(ClientPingMessage(id: id, ts: epochMs(now))))
    }

    /// Noma'lum `type` ulanishni buzmaydi (`.unknown`); buzilgan JSON uchun nil.
    public static func decode(_ data: Data) -> ServerToClientMessage? {
        try? JSONDecoder().decode(ServerToClientMessage.self, from: data)
    }

    static func epochMs(_ d: Date) -> Int { Int((d.timeIntervalSince1970 * 1000).rounded()) }
}
