import CommanderContracts
import MenuBarCore
import XCTest
@testable import DashboardCore

final class LiveHubTests: XCTestCase {
    private let url = URL(string: "wss://center.test/ws/client")!
    private let sessionId = "83552025-a572-408a-8a97-2bc8d63e35cf"

    private struct Rig {
        let hub: LiveHub
        let socket: FakeLiveSocket
        let sleeper: ManualSleeper
        let clock: FakeClock
    }

    private func makeRig() -> Rig {
        let socket = FakeLiveSocket()
        let sleeper = ManualSleeper()
        let clock = FakeClock()
        let hub = LiveHub(socket: socket, clock: clock, sleeper: sleeper, random: { 0.5 }, makeID: { "id" })
        return Rig(hub: hub, socket: socket, sleeper: sleeper, clock: clock)
    }

    /// Hodisalarni yig'adi (alohida vazifada), testda tekshirish uchun.
    private final class Collector: @unchecked Sendable {
        private let events = Locked<[LiveEvent]>([])
        private var task: Task<Void, Never>?

        init(_ stream: AsyncStream<LiveEvent>) {
            task = Task { [events] in
                for await event in stream { events.withValue { $0.append(event) } }
            }
        }

        var all: [LiveEvent] { events.withValue { $0 } }
        func stop() { task?.cancel() }

        var statuses: [ConnectionStatus] { all.compactMap { if case .status(let s) = $0 { s } else { nil } } }
        var messages: [ServerToClientMessage] { all.compactMap { if case .message(let m) = $0 { m } else { nil } } }
        var resyncCount: Int { all.filter { if case .resync = $0 { true } else { false } }.count }
    }


    /// Aloqa uzilgach: avval `.reconnecting` holati, so'ng heartbeat bekor bo'lib faqat qayta ulanish kutishi qolishi.
    private func awaitReconnectWait(_ rig: Rig) async -> Bool {
        let hub = rig.hub, sleeper = rig.sleeper
        guard await eventually({ if case .reconnecting = await hub.status { true } else { false } }) else { return false }
        return await eventually { await sleeper.pendingCount == 1 }
    }

    private func connectAndAuth(_ rig: Rig) async throws {
        await rig.hub.start(url: url, token: "tok")
        let socket = rig.socket
        let hub = rig.hub
        let connected = await eventually { socket.connectCount == 1 }
        XCTAssertTrue(connected)
        try socket.push(serverMessage("server-auth-ok"))
        let live = await eventually { await hub.status == .live }
        XCTAssertTrue(live)
    }

    // MARK: ulanish va autentifikatsiya

    func testStartConnectsWithTokenAndReportsConnecting() async {
        let rig = makeRig()
        await rig.hub.start(url: url, token: "tok")
        XCTAssertEqual(rig.socket.lastConnect?.url, url)
        XCTAssertEqual(rig.socket.lastConnect?.token, "tok")
        let status = await rig.hub.status
        XCTAssertEqual(status, .connecting)
    }

    func testAuthOkGoesLiveAndSubscribesRegisteredChannels() async throws {
        let rig = makeRig()
        let collector = Collector(await rig.hub.events(channels: [.sessions, .approvals]))
        try await connectAndAuth(rig)
        let socket = rig.socket
        let sent = await eventually { socket.subscribedChannels().count == 1 }
        XCTAssertTrue(sent)
        XCTAssertEqual(Set(socket.subscribedChannels()[0]), [.sessions, .approvals])
        XCTAssertTrue(collector.statuses.contains(.live))
        XCTAssertTrue(collector.messages.contains { if case .authOk = $0 { true } else { false } })
        collector.stop()
    }

    func testSubscribedAckTriggersResyncOnlyForIntersectingSubscribers() async throws {
        let rig = makeRig()
        let sessions = Collector(await rig.hub.events(channels: [.sessions]))
        let limits = Collector(await rig.hub.events(channels: [.limits]))
        try await connectAndAuth(rig)
        try rig.socket.push(serverMessage("server-subscribed")) // sessions, approvals
        let resynced = await eventually { sessions.resyncCount == 1 }
        XCTAssertTrue(resynced)
        XCTAssertEqual(limits.resyncCount, 0)
        sessions.stop(); limits.stop()
    }

    // MARK: yo'naltirish

    func testMessagesGoOnlyToSubscribedChannelsExceptBroadcasts() async throws {
        let rig = makeRig()
        let sessions = Collector(await rig.hub.events(channels: [.sessions]))
        let machines = Collector(await rig.hub.events(channels: [.machines]))
        try await connectAndAuth(rig)

        try rig.socket.push(serverMessage("server-session-updated"))
        try rig.socket.push(serverMessage("server-lockdown-updated"))
        let delivered = await eventually { sessions.messages.count == 3 && machines.messages.count == 2 } // authOk + lockdown (+ session)
        XCTAssertTrue(delivered)
        XCTAssertTrue(sessions.messages.contains { if case .sessionUpdated = $0 { true } else { false } })
        XCTAssertFalse(machines.messages.contains { if case .sessionUpdated = $0 { true } else { false } })
        XCTAssertTrue(machines.messages.contains { if case .lockdownUpdated = $0 { true } else { false } })
        sessions.stop(); machines.stop()
    }

    // MARK: ref-count

    func testSameChannelFromTwoSubscribersIsSubscribedOnce() async throws {
        let rig = makeRig()
        let first = Collector(await rig.hub.events(channels: [.sessions]))
        try await connectAndAuth(rig)
        let socket = rig.socket
        _ = await eventually { socket.subscribedChannels().count == 1 }

        let second = Collector(await rig.hub.events(channels: [.sessions, .machines]))
        let added = await eventually { socket.subscribedChannels().count == 2 }
        XCTAssertTrue(added)
        XCTAssertEqual(socket.subscribedChannels()[1], [.machines], "faqat yangi kanal yuboriladi")

        second.stop()
        let dropped = await eventually { socket.unsubscribedChannels().count == 1 }
        XCTAssertTrue(dropped)
        XCTAssertEqual(socket.unsubscribedChannels()[0], [.machines], "sessions hali birinchi obunachiga kerak")

        first.stop()
        let all = await eventually { socket.unsubscribedChannels().count == 2 }
        XCTAssertTrue(all)
        XCTAssertEqual(socket.unsubscribedChannels()[1], [.sessions])
    }

    // MARK: qayta ulanish

    func testNetworkDropReconnectsWithBackoffAndResetsAfterAuth() async throws {
        let rig = makeRig()
        let collector = Collector(await rig.hub.events(channels: [.sessions]))
        try await connectAndAuth(rig)

        rig.socket.close(code: nil)
        let hub = rig.hub, sleeper = rig.sleeper, socket = rig.socket
        let waiting = await awaitReconnectWait(rig)
        XCTAssertTrue(waiting)
        guard case .reconnecting(let attempt, _) = await hub.status else { return XCTFail("reconnecting kutilgan") }
        XCTAssertEqual(attempt, 1)

        await sleeper.releaseAll()
        let reconnected = await eventually { socket.connectCount == 2 }
        XCTAssertTrue(reconnected)

        try socket.push(serverMessage("server-auth-ok"))
        _ = await eventually { await hub.status == .live }
        XCTAssertEqual(socket.subscribedChannels().count, 2, "qayta ulanganda obuna qaytariladi")

        socket.close(code: nil)
        let waitingAgain = await awaitReconnectWait(rig)
        XCTAssertTrue(waitingAgain)
        guard case .reconnecting(let again, _) = await hub.status else { return XCTFail("reconnecting kutilgan") }
        XCTAssertEqual(again, 1, "auth.ok backoff'ni nolga tushirgan")
        collector.stop()
    }

    func testRevokedTokenStopsReconnecting() async throws {
        let rig = makeRig()
        try await connectAndAuth(rig)
        rig.socket.close(code: CommanderContract.clientWsCloseRevoked)
        let hub = rig.hub
        let stopped = await eventually { if case .unauthorized = await hub.status { true } else { false } }
        XCTAssertTrue(stopped)
        let pending = await rig.sleeper.pendingCount
        XCTAssertEqual(pending, 0)
        XCTAssertEqual(rig.socket.connectCount, 1)
    }

    func testAuthErrorMessageStopsWithoutReconnect() async throws {
        let rig = makeRig()
        await rig.hub.start(url: url, token: "bad")
        let authError = try JSONDecoder().decode(ServerToClientMessage.self, from: Data("""
        {"v":1,"id":"00000000-0000-4000-8000-0000000000e1","type":"auth.error","ts":1763092800000,"payload":{"code":"invalid_token","message":"x"}}
        """.utf8))
        try rig.socket.push(authError)
        let hub = rig.hub
        let stopped = await eventually { if case .unauthorized = await hub.status { true } else { false } }
        XCTAssertTrue(stopped)
        XCTAssertEqual(rig.socket.connectCount, 1)
    }

    func testReconnectNowSkipsBackoff() async throws {
        let rig = makeRig()
        try await connectAndAuth(rig)
        rig.socket.close(code: nil)
        let socket = rig.socket
        let waiting = await awaitReconnectWait(rig)
        XCTAssertTrue(waiting)
        await rig.hub.reconnectNow()
        XCTAssertEqual(socket.connectCount, 2)
    }

    func testStopDisconnectsAndReportsUnpaired() async throws {
        let rig = makeRig()
        try await connectAndAuth(rig)
        await rig.hub.stop()
        let status = await rig.hub.status
        XCTAssertEqual(status, .unpaired)
        XCTAssertGreaterThanOrEqual(rig.socket.disconnectCount, 1)
    }

    // MARK: heartbeat

    func testHeartbeatSendsPingWhileActiveAndDropsSilentConnection() async throws {
        let rig = makeRig()
        try await connectAndAuth(rig)
        let sleeper = rig.sleeper, socket = rig.socket, hub = rig.hub
        _ = await eventually { await sleeper.pendingCount >= 1 }

        rig.clock.advance(10)
        await sleeper.releaseAll()
        let pinged = await eventually { socket.pingCount == 1 }
        XCTAssertTrue(pinged, "jim emas: ping yuboriladi")

        rig.clock.advance(100) // 70 s dan uzoq hech narsa kelmadi
        _ = await eventually { await sleeper.pendingCount >= 1 }
        await sleeper.releaseAll()
        let dropped = await eventually { if case .reconnecting = await hub.status { true } else { false } }
        XCTAssertTrue(dropped, "o'lik ulanish uziladi va qayta ulanadi")
    }

    // MARK: chat

    func testChatOpensOnFirstSubscriberRoutesBySessionAndClosesOnLast() async throws {
        let rig = makeRig()
        try await connectAndAuth(rig)
        let socket = rig.socket
        let chat = Collector(await rig.hub.chatEvents(sessionId: sessionId, limit: 50))
        let other = Collector(await rig.hub.chatEvents(sessionId: "other-session"))
        _ = await eventually { socket.chatOpens().count == 2 }
        XCTAssertEqual(socket.chatOpens().first { $0.sessionId == sessionId }?.limit, 50)

        try socket.push(serverMessage("server-chat-state"))
        let got = await eventually { chat.messages.contains { if case .chatState = $0 { true } else { false } } }
        XCTAssertTrue(got)
        XCTAssertFalse(other.messages.contains { if case .chatState = $0 { true } else { false } })

        chat.stop()
        let id = sessionId
        let closed = await eventually { socket.chatCloses() == [id] }
        XCTAssertTrue(closed)
        other.stop()
    }

    func testChatIsReopenedAfterReconnectAndOlderPagesUseBefore() async throws {
        let rig = makeRig()
        try await connectAndAuth(rig)
        let socket = rig.socket, sleeper = rig.sleeper, hub = rig.hub
        let chat = Collector(await rig.hub.chatEvents(sessionId: sessionId, limit: 30))
        _ = await eventually { socket.chatOpens().count == 1 }

        await rig.hub.requestOlderChat(sessionId: sessionId, before: "cur-1", limit: 30)
        let older = await eventually { socket.chatOpens().contains { $0.before == "cur-1" } }
        XCTAssertTrue(older)

        socket.close(code: nil)
        let waiting = await awaitReconnectWait(rig)
        XCTAssertTrue(waiting)
        await sleeper.releaseAll()
        _ = await eventually { socket.connectCount == 2 }
        try socket.push(serverMessage("server-auth-ok"))
        _ = await eventually { await hub.status == .live }
        let reopened = await eventually { socket.chatOpens().filter { $0.before == nil }.count == 2 }
        XCTAssertTrue(reopened, "qayta ulangach chat.open (before'siz) yana yuboriladi")
        chat.stop()
    }
}
