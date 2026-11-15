import CommanderContracts
import XCTest
@testable import DashboardCore

final class ChatTimelineTests: XCTestCase {
    private func batch(_ name: String) throws -> ChatBatch {
        guard case .chatItems(let message) = try serverMessage(name) else { throw XCTSkip("chat.items emas") }
        return ChatBatch(message.payload)
    }

    private func user(_ id: String, _ text: String = "x") -> ChatItem {
        .user(ChatUserItem(id: id, ts: 1, text: text))
    }

    private func make(_ items: [ChatItem], replace: Bool = false, older: Bool = false, cursor: String? = nil) -> ChatBatch {
        ChatBatch(ChatItemsToClientPayload(sessionId: "s", items: items, replace: replace, older: older, cursor: cursor))
    }

    func testReplaceBatchFromFixtureLoadsEverythingAndKeepsUnknownKind() throws {
        var timeline = ChatTimeline()
        try timeline.apply(batch("server-chat-items"))
        XCTAssertEqual(timeline.items.count, 8)
        XCTAssertTrue(timeline.loaded)
        XCTAssertFalse(timeline.canLoadOlder)
        guard case .unknown(let kind, _) = timeline.items[7] else { return XCTFail("kelajak turi saqlanadi") }
        XCTAssertEqual(kind, "future_kind_v9")
    }

    func testAppendReplacesSameIdAndAddsNew() {
        var timeline = ChatTimeline()
        timeline.apply(make([user("a", "1"), user("b", "2")], replace: true))
        timeline.apply(make([user("b", "2-yangilandi"), user("c", "3")]))
        XCTAssertEqual(timeline.items.compactMap(\.itemId), ["a", "b", "c"])
        guard case .user(let b) = timeline.items[1] else { return XCTFail("user") }
        XCTAssertEqual(b.text, "2-yangilandi")
    }

    func testOlderPagePrependsWithoutDuplicatesAndUpdatesCursor() {
        var timeline = ChatTimeline()
        timeline.apply(make([user("c"), user("d")], replace: true, cursor: "cur-1"))
        XCTAssertTrue(timeline.canLoadOlder)

        timeline.apply(make([user("a"), user("b"), user("c")], older: true, cursor: nil))
        XCTAssertEqual(timeline.items.compactMap(\.itemId), ["a", "b", "c", "d"])
        XCTAssertFalse(timeline.canLoadOlder, "boshiga yetildi")
    }

    func testReplaceDropsPreviousItemsAndDuplicatesInsideBatch() {
        var timeline = ChatTimeline()
        timeline.apply(make([user("old")], replace: true))
        timeline.apply(make([user("n1"), user("n1"), user("n2")], replace: true))
        XCTAssertEqual(timeline.items.compactMap(\.itemId), ["n1", "n2"])
    }
}
