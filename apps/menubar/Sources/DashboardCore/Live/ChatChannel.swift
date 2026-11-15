import CommanderContracts
import Foundation
import MenuBarCore

public enum ChatEvent: Sendable {
    case state(ChatState, code: ChatErrorCode?)
    case batch(ChatBatch)
    case status(ConnectionStatus)
    /// Server `error` yubordi (masalan `chat.open` tezligi oshdi).
    case serverError(ServerErrorMessagePayloadCode)
}

/// Bitta sessiya chati: `LiveHub` ustida `chat.open` -> backfill -> `chat.state live` -> qo'shimchalar; eski sahifa `loadOlder`.
/// Oqim bekor qilinganda `chat.close` avtomatik yuboriladi (hub obunasi tugaydi).
public struct ChatChannel: Sendable {
    public let sessionId: String
    private let hub: LiveHub

    public init(hub: LiveHub, sessionId: String) {
        self.hub = hub
        self.sessionId = sessionId
    }

    public func open(limit: Int? = nil) async -> AsyncStream<ChatEvent> {
        let source = await hub.chatEvents(sessionId: sessionId, limit: limit)
        let sessionId = sessionId
        return AsyncStream { continuation in
            let task = Task {
                for await event in source {
                    if let mapped = Self.map(event, sessionId: sessionId) { continuation.yield(mapped) }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Eskiroq sahifani so'raydi; javob `ChatBatch(older: true)` bo'lib keladi.
    public func loadOlder(before cursor: String, limit: Int? = nil) async {
        await hub.requestOlderChat(sessionId: sessionId, before: cursor, limit: limit)
    }

    static func map(_ event: LiveEvent, sessionId: String) -> ChatEvent? {
        switch event {
        case .status(let status): .status(status)
        case .resync: nil
        case .message(let message):
            switch message {
            case .chatItems(let items) where items.payload.sessionId == sessionId: .batch(ChatBatch(items.payload))
            case .chatState(let state) where state.payload.sessionId == sessionId: .state(state.payload.state, code: state.payload.code)
            case .error(let error): .serverError(error.payload.code)
            default: nil
            }
        }
    }
}
