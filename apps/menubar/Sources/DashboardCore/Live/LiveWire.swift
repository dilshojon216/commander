import CommanderContracts
import Foundation

/// Klient -> server kadrlarini yig'adi (generatsiya qilingan tiplar orqali). Id/vaqt tashqaridan: testlar deterministik.
struct LiveWire {
    let clock: any ClockProviding
    let makeID: @Sendable () -> String

    private var epochMs: Int { Int((clock.now.timeIntervalSince1970 * 1000).rounded()) }

    func subscribe(_ channels: Set<ClientChannel>) -> ClientToServerMessage {
        .subscribe(ClientSubscribeMessage(id: makeID(), ts: epochMs, payload: ClientSubscribePayload(channels: sorted(channels))))
    }

    func unsubscribe(_ channels: Set<ClientChannel>) -> ClientToServerMessage {
        .unsubscribe(ClientUnsubscribeMessage(id: makeID(), ts: epochMs, payload: ClientSubscribePayload(channels: sorted(channels))))
    }

    func chatOpen(sessionId: String, limit: Int? = nil, before: String? = nil) -> ClientToServerMessage {
        .chatOpen(ChatOpenMessage(id: makeID(), ts: epochMs, payload: ChatOpenPayload(sessionId: sessionId, limit: limit, before: before)))
    }

    func chatClose(sessionId: String) -> ClientToServerMessage {
        .chatClose(ChatCloseMessage(id: makeID(), ts: epochMs, payload: ChatClosePayload(sessionId: sessionId)))
    }

    func ping() -> ClientToServerMessage {
        .ping(ClientPingMessage(id: makeID(), ts: epochMs))
    }

    /// Chiqish tartibi barqaror bo'lishi uchun (testlar va log).
    private func sorted(_ channels: Set<ClientChannel>) -> [ClientChannel] {
        channels.sorted { "\($0)" < "\($1)" }
    }
}
