import CommanderContracts
import Foundation
import MenuBarCore

/// Butun ilova uchun BITTA `/ws/client` ulanishi (panel + dashboard oynasi). Obunachilar kanal bo'yicha ref-count bilan
/// qo'shiladi/chiqadi; ulanish uzilsa `ReconnectPolicy` bo'yicha qayta ulanadi va tiklangach `resync` yuboradi.
public actor LiveHub {
    static let pingInterval: TimeInterval = 25
    /// Shuncha vaqt hech narsa kelmasa ulanish o'lik hisoblanadi.
    static let silenceTimeout: TimeInterval = 70

    public private(set) var status: ConnectionStatus = .unpaired

    let socket: any LiveSocket
    let clock: any ClockProviding
    let sleeper: any Sleeping
    let random: @Sendable () -> Double
    let wire: LiveWire

    var registry = SubscriptionRegistry()
    private var credentials: (url: URL, token: String)?
    private var reconnect: ReconnectState
    private var generation = 0
    private var ready = false
    private var lastActivity = Date.distantPast
    private var readerTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?

    public init(
        socket: any LiveSocket,
        clock: any ClockProviding = SystemClock(),
        sleeper: any Sleeping = TaskSleeper(),
        policy: ReconnectPolicy = ReconnectPolicy(),
        random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) },
        makeID: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.socket = socket
        self.clock = clock
        self.sleeper = sleeper
        self.random = random
        self.wire = LiveWire(clock: clock, makeID: makeID)
        self.reconnect = ReconnectState(policy: policy)
    }

    // MARK: ulanish

    /// Ulanishni boshlaydi (avvalgisi bo'lsa almashtiriladi).
    public func start(url: URL, token: String) {
        credentials = (url, token)
        reconnect = ReconnectState(policy: reconnect.policy)
        connectNow()
    }

    /// To'xtatadi (unpair yoki token rad etilganda); obunachilar saqlanadi, `start` bilan qayta tiklanadi.
    public func stop() {
        credentials = nil
        shutdown()
        setStatus(.unpaired)
    }

    /// "Qayta ulash" tugmasi: backoff'ni kutmasdan.
    public func reconnectNow() {
        guard credentials != nil else { return }
        reconnect.connected()
        connectNow()
    }

    // MARK: obuna

    /// Kanallar bo'yicha hodisalar oqimi. Oqim tugatilganda (bekor qilinganda) obuna avtomatik olinadi.
    public func events(channels: Set<ClientChannel>) -> AsyncStream<LiveEvent> {
        register(channels: channels, chatSession: nil, chatLimit: nil)
    }

    /// Bitta sessiya chati oqimi (`chat.items` / `chat.state`); birinchi obunachi `chat.open` yuboradi, oxirgisi `chat.close`.
    public func chatEvents(sessionId: String, limit: Int? = nil) -> AsyncStream<LiveEvent> {
        register(channels: [], chatSession: sessionId, chatLimit: limit)
    }

    /// Eski chat sahifasi (`chat.open {before}`): javob `chat.items {older: true}` sifatida keladi.
    public func requestOlderChat(sessionId: String, before: String, limit: Int? = nil) {
        send(wire.chatOpen(sessionId: sessionId, limit: limit, before: before))
    }

    // MARK: ichki: ro'yxatga olish

    private func register(channels: Set<ClientChannel>, chatSession: String?, chatLimit: Int?) -> AsyncStream<LiveEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<LiveEvent>.makeStream()
        continuation.yield(.status(status))
        let added = registry.add(id: id, channels: channels, chatSession: chatSession, chatLimit: chatLimit, continuation: continuation)
        if ready {
            if !added.newChannels.isEmpty { send(wire.subscribe(added.newChannels)) }
            if let session = added.newChat { send(wire.chatOpen(sessionId: session, limit: chatLimit)) }
        }
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unregister(id) }
        }
        return stream
    }

    private func unregister(_ id: UUID) {
        let dropped = registry.remove(id: id)
        guard ready else { return }
        if !dropped.droppedChannels.isEmpty { send(wire.unsubscribe(dropped.droppedChannels)) }
        if let session = dropped.droppedChat { send(wire.chatClose(sessionId: session)) }
    }

    // MARK: ichki: ulanish hayot sikli

    private func connectNow() {
        shutdown()
        guard let credentials else { return }
        generation += 1
        let gen = generation
        setStatus(.connecting)
        lastActivity = clock.now
        let events = socket.connect(url: credentials.url, token: credentials.token)
        readerTask = Task { [weak self] in
            for await event in events { await self?.handle(event, generation: gen) }
            await self?.handle(.closed(code: nil), generation: gen)
        }
        heartbeatTask = Task { [weak self] in await self?.heartbeat(generation: gen) }
    }

    /// Joriy ulanish va vazifalarni to'xtatadi (qayta ulanish rejasi ham bekor).
    private func shutdown() {
        generation += 1
        ready = false
        readerTask?.cancel()
        heartbeatTask?.cancel()
        reconnectTask?.cancel()
        readerTask = nil
        heartbeatTask = nil
        reconnectTask = nil
        socket.disconnect()
    }

    private func handle(_ event: LiveSocketEvent, generation gen: Int) {
        guard gen == generation else { return }
        switch event {
        case .received(let data):
            lastActivity = clock.now
            if let message = ClientWire.decode(data) { route(message) }
        case .closed(let code):
            connectionClosed(code: code)
        }
    }

    private func route(_ message: ServerToClientMessage) {
        switch message {
        case .authOk:
            reconnect.connected()
            ready = true
            setStatus(.live)
            deliver(.message(message), to: registry.allContinuations)
            resubscribeAll()
        case .authError(let error):
            let reason = "Token rad etildi (\(error.payload.code.rawValue)): qayta ulang"
            credentials = nil
            shutdown()
            setStatus(.unauthorized(reason: reason))
        case .subscribed(let ack):
            deliver(.resync, to: registry.resyncRecipients(for: Set(ack.payload.channels)))
        default:
            deliver(.message(message), to: registry.recipients(for: message.route))
        }
    }

    private func connectionClosed(code: Int?) {
        ready = false
        heartbeatTask?.cancel()
        let decision = CloseDecision.from(code: code)
        guard let delay = reconnect.next(after: decision, random: random()) else {
            credentials = nil
            if case .stop(let reason) = decision { setStatus(.unauthorized(reason: reason)) }
            return
        }
        setStatus(.reconnecting(attempt: reconnect.attempt, retryAt: clock.now.addingTimeInterval(delay)))
        let gen = generation
        reconnectTask = Task { [weak self, sleeper] in
            try? await sleeper.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.reconnectDue(generation: gen)
        }
    }

    private func reconnectDue(generation gen: Int) {
        guard gen == generation else { return }
        connectNow()
    }

    private func heartbeat(generation gen: Int) async {
        while !Task.isCancelled {
            try? await sleeper.sleep(for: Self.pingInterval)
            guard !Task.isCancelled, gen == generation else { return }
            if clock.now.timeIntervalSince(lastActivity) > Self.silenceTimeout {
                socket.disconnect()
                connectionClosed(code: nil)
                return
            }
            send(wire.ping())
        }
    }

    /// `auth.ok` dan keyin: hozirgi barcha kanallar va ochiq chatlar qayta yuboriladi.
    private func resubscribeAll() {
        let channels = registry.activeChannels
        if !channels.isEmpty { send(wire.subscribe(channels)) }
        for session in registry.activeChatSessions {
            send(wire.chatOpen(sessionId: session, limit: registry.chatLimits[session] ?? nil))
        }
    }

    // MARK: ichki: yordamchilar

    func send(_ message: ClientToServerMessage) {
        guard let data = try? JSONEncoder().encode(message) else { return }
        socket.send(data)
    }

    private func deliver(_ event: LiveEvent, to targets: [SubscriptionRegistry.Continuation]) {
        for target in targets { target.yield(event) }
    }

    private func setStatus(_ new: ConnectionStatus) {
        guard new != status else { return }
        status = new
        deliver(.status(new), to: registry.allContinuations)
    }
}
