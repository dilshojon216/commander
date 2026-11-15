import CommanderContracts
import Foundation
import MenuBarCore

/// `/ws/client` ulanishi (URLSessionWebSocketTask). Token `Sec-WebSocket-Protocol` orqali
/// (`ClientWebSocketAuth.subprotocols`), hech qachon query string'da emas.
@MainActor
final class ClientSocket {
    var onMessage: ((ServerToClientMessage) -> Void)?
    /// Yopilish kodi (nil = tarmoq uzilishi / noma'lum).
    var onClose: ((Int?) -> Void)?

    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var lastMessageAt = Date()
    private var generation = 0

    static let pingInterval: TimeInterval = 25
    /// Shuncha vaqt hech narsa kelmasa ulanish o'lik deb hisoblanadi.
    static let silenceTimeout: TimeInterval = 70

    init() {
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = false
        cfg.timeoutIntervalForRequest = 30
        session = URLSession(configuration: cfg)
    }

    func connect(url: URL, token: String) {
        disconnect()
        generation += 1
        let gen = generation
        let t = session.webSocketTask(with: url, protocols: ClientWebSocketAuth.subprotocols(token: token))
        t.maximumMessageSize = 4 * 1024 * 1024
        task = t
        lastMessageAt = Date()
        t.resume()
        receiveLoop = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let msg = try await t.receive()
                    guard let self, self.generation == gen else { return }
                    self.lastMessageAt = Date()
                    let data: Data?
                    switch msg {
                    case .string(let s): data = s.data(using: .utf8)
                    case .data(let d): data = d
                    @unknown default: data = nil
                    }
                    if let data, let decoded = ClientWire.decode(data) { self.onMessage?(decoded) }
                } catch {
                    guard let self, self.generation == gen else { return }
                    let raw = t.closeCode.rawValue
                    self.finish(code: raw == 0 ? nil : raw)
                    return
                }
            }
        }
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.pingInterval))
                guard let self, self.generation == gen, !Task.isCancelled else { return }
                if Date().timeIntervalSince(self.lastMessageAt) > Self.silenceTimeout {
                    t.cancel(with: .abnormalClosure, reason: nil)
                    self.finish(code: nil)
                    return
                }
                if let ping = ClientWire.ping() { self.send(ping) }
            }
        }
    }

    func send(_ data: Data) {
        guard let s = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(s)) { _ in }
    }

    func disconnect() {
        generation += 1
        receiveLoop?.cancel()
        heartbeat?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func finish(code: Int?) {
        generation += 1
        receiveLoop?.cancel()
        heartbeat?.cancel()
        task = nil
        onClose?(code)
    }
}
