import CommanderContracts
import MenuBarCore
import XCTest
@testable import DashboardCore

final class ChatChannelTests: XCTestCase {
    private let url = URL(string: "wss://center.test/ws/client")!
    private let sessionId = "83552025-a572-408a-8a97-2bc8d63e35cf"

    private func liveHub() async throws -> (LiveHub, FakeLiveSocket) {
        let socket = FakeLiveSocket()
        let hub = LiveHub(socket: socket, clock: FakeClock(), sleeper: ManualSleeper(), makeID: { "id" })
        await hub.start(url: url, token: "tok")
        try socket.push(serverMessage("server-auth-ok"))
        _ = await eventually { await hub.status == .live }
        return (hub, socket)
    }

    func testOpenStreamsStateAndBatchesForThatSessionOnly() async throws {
        let (hub, socket) = try await liveHub()
        let channel = ChatChannel(hub: hub, sessionId: sessionId)
        let stream = await channel.open(limit: 50)
        let received = Locked<[ChatEvent]>([])
        let reader = Task { for await event in stream { received.withValue { $0.append(event) } } }

        _ = await eventually { socket.chatOpens().count == 1 }
        try socket.push(serverMessage("server-chat-state"))
        try socket.push(serverMessage("server-chat-items"))
        let got = await eventually { received.withValue { $0 }.count >= 3 } // status + state + batch
        XCTAssertTrue(got)

        let events = received.withValue { $0 }
        XCTAssertTrue(events.contains { if case .state(.live, _) = $0 { true } else { false } })
        XCTAssertTrue(events.contains { if case .batch(let b) = $0 { b.items.count == 8 && b.replace } else { false } })
        reader.cancel()
    }

    func testLoadOlderSendsChatOpenWithCursor() async throws {
        let (hub, socket) = try await liveHub()
        let channel = ChatChannel(hub: hub, sessionId: sessionId)
        await channel.loadOlder(before: "cur-9", limit: 20)
        let sent = await eventually { socket.chatOpens().contains { $0.before == "cur-9" && $0.limit == 20 } }
        XCTAssertTrue(sent)
    }

    func testMapIgnoresOtherSessionsAndResync() throws {
        let other = try serverMessage("server-chat-state") // boshqa sessiya id bilan solishtiramiz
        XCTAssertNil(ChatChannel.map(.message(other), sessionId: "boshqa"))
        XCTAssertNil(ChatChannel.map(.resync, sessionId: sessionId))
    }
}
