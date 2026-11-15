import CommanderContracts
import DashboardCore
import Foundation

/// Soxta WebSocket: serverdan kelgan xabarni qo'lda yuboradi, yuborilganlarni yozib oladi.
final class FakeLiveSocket: LiveSocket {
    private struct State {
        var continuation: AsyncStream<LiveSocketEvent>.Continuation?
        var connects: [(url: URL, token: String)] = []
        var sent: [Data] = []
        var disconnects = 0
    }

    private let state = Locked(State())

    var connectCount: Int { state.withValue { $0.connects.count } }
    var lastConnect: (url: URL, token: String)? { state.withValue { $0.connects.last } }
    var disconnectCount: Int { state.withValue { $0.disconnects } }

    /// Yuborilgan klient xabarlari (dekodlangan).
    var sentMessages: [ClientToServerMessage] {
        state.withValue { $0.sent }.compactMap { try? JSONDecoder().decode(ClientToServerMessage.self, from: $0) }
    }

    func connect(url: URL, token: String) -> AsyncStream<LiveSocketEvent> {
        let (stream, continuation) = AsyncStream<LiveSocketEvent>.makeStream()
        state.withValue {
            $0.continuation?.finish()
            $0.continuation = continuation
            $0.connects.append((url, token))
        }
        return stream
    }

    func send(_ data: Data) { state.withValue { $0.sent.append(data) } }

    func disconnect() {
        state.withValue {
            $0.disconnects += 1
            $0.continuation?.finish()
            $0.continuation = nil
        }
    }

    func push(_ message: ServerToClientMessage) throws {
        let data = try JSONEncoder().encode(message)
        state.withValue { $0.continuation }?.yield(.received(data))
    }

    func close(code: Int?) {
        state.withValue { $0.continuation }?.yield(.closed(code: code))
    }

    // MARK: kadr tanlovi

    func subscribedChannels() -> [[ClientChannel]] {
        sentMessages.compactMap { if case .subscribe(let m) = $0 { m.payload.channels } else { nil } }
    }

    func unsubscribedChannels() -> [[ClientChannel]] {
        sentMessages.compactMap { if case .unsubscribe(let m) = $0 { m.payload.channels } else { nil } }
    }

    func chatOpens() -> [ChatOpenPayload] {
        sentMessages.compactMap { if case .chatOpen(let m) = $0 { m.payload } else { nil } }
    }

    func chatCloses() -> [String] {
        sentMessages.compactMap { if case .chatClose(let m) = $0 { m.payload.sessionId } else { nil } }
    }

    var pingCount: Int {
        sentMessages.filter { if case .ping = $0 { true } else { false } }.count
    }
}

/// Kutishni qo'lda boshqaradi: `sleep` chaqirilganda to'xtaydi, `releaseAll()` hammasini uyg'otadi. So'ralgan muddatlarni yozadi.
actor ManualSleeper: Sleeping {
    private var waiters: [(id: Int, continuation: CheckedContinuation<Void, Error>)] = []
    private var nextID = 0
    private(set) var requested: [TimeInterval] = []

    func sleep(for seconds: TimeInterval) async throws {
        requested.append(seconds)
        let id = nextID
        nextID += 1
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiters.append((id, continuation))
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    func releaseAll() {
        let current = waiters
        waiters.removeAll()
        for waiter in current { waiter.continuation.resume() }
    }

    var pendingCount: Int { waiters.count }

    private func cancel(_ id: Int) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: index).continuation.resume(throwing: CancellationError())
    }
}

/// Shart bajarilguncha kutadi (asinxron hodisalar uchun); muddat o'tsa `false`.
func eventually(timeout: TimeInterval = 2, _ condition: @escaping @Sendable () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return false
}

/// Fixture'dan server xabarini o'qiydi.
func serverMessage(_ name: String) throws -> ServerToClientMessage {
    try JSONDecoder().decode(ServerToClientMessage.self, from: Fixtures.data("ws/\(name)"))
}
