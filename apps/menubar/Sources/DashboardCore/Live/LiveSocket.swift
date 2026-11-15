import CommanderContracts
import Foundation

public enum LiveSocketEvent: Sendable, Equatable {
    case received(Data)
    /// Yopilish kodi (nil = tarmoq uzilishi / noma'lum).
    case closed(code: Int?)
}

/// `/ws/client` ulanishi: ishlab chiqarishda `URLSessionWebSocketTask`, testda soxta.
/// Heartbeat va qayta ulanish bu yerda EMAS (`LiveHub`da), shuning uchun transport sodda.
public protocol LiveSocket: Sendable {
    /// Yangi ulanish ochadi (avvalgisi yopiladi); hodisalar oqimi `.closed` bilan tugaydi.
    func connect(url: URL, token: String) -> AsyncStream<LiveSocketEvent>
    func send(_ data: Data)
    func disconnect()
}

/// `URLSessionWebSocketTask` asosidagi transport. Token `Sec-WebSocket-Protocol` orqali (`ClientWebSocketAuth.subprotocols`),
/// hech qachon query string'da emas.
public final class URLSessionLiveSocket: LiveSocket {
    private static let maxMessageSize = 4 * 1024 * 1024

    private let session: URLSession
    private let current = LockedBox<URLSessionWebSocketTask?>(nil)

    public init() {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 30
        session = URLSession(configuration: config)
    }

    public func connect(url: URL, token: String) -> AsyncStream<LiveSocketEvent> {
        disconnect()
        let task = session.webSocketTask(with: url, protocols: ClientWebSocketAuth.subprotocols(token: token))
        task.maximumMessageSize = Self.maxMessageSize
        current.withValue { $0 = task }
        task.resume()
        return AsyncStream { continuation in
            let reader = Task {
                await Self.pump(task, into: continuation)
            }
            continuation.onTermination = { _ in
                reader.cancel()
                task.cancel(with: .normalClosure, reason: nil)
            }
        }
    }

    public func send(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        current.withValue { $0 }?.send(.string(text)) { _ in }
    }

    public func disconnect() {
        current.withValue { task in
            task?.cancel(with: .normalClosure, reason: nil)
            task = nil
        }
    }

    private static func pump(_ task: URLSessionWebSocketTask, into continuation: AsyncStream<LiveSocketEvent>.Continuation) async {
        while !Task.isCancelled {
            do {
                switch try await task.receive() {
                case .string(let text): continuation.yield(.received(Data(text.utf8)))
                case .data(let data): continuation.yield(.received(data))
                @unknown default: break
                }
            } catch {
                let raw = task.closeCode.rawValue
                continuation.yield(.closed(code: raw == 0 ? nil : raw))
                continuation.finish()
                return
            }
        }
        continuation.finish()
    }
}
