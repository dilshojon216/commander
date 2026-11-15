import XCTest
@testable import DashboardCore

private struct Row: Identifiable, Sendable, Equatable {
    let id: Int
}

@MainActor
final class PagedLoaderTests: XCTestCase {
    private func pages(_ list: [Page<Row>]) -> (PagedLoader<Row>, Locked<[String?]>) {
        let cursors = Locked<[String?]>([])
        let queue = Locked(list)
        let loader = PagedLoader<Row> { cursor throws(APIError) in
            cursors.withValue { $0.append(cursor) }
            guard let next = queue.withValue({ $0.isEmpty ? nil : $0.removeFirst() }) else { throw .notFound }
            return next
        }
        return (loader, cursors)
    }

    func testReloadThenLoadMoreAppendsUntilNoCursor() async {
        let (loader, cursors) = pages([
            Page(items: [Row(id: 1), Row(id: 2)], nextCursor: "c1"),
            Page(items: [Row(id: 3)], nextCursor: nil),
        ])
        await loader.reload()
        XCTAssertEqual(loader.items.map(\.id), [1, 2])
        XCTAssertTrue(loader.hasMore)

        await loader.loadMore()
        XCTAssertEqual(loader.items.map(\.id), [1, 2, 3])
        XCTAssertFalse(loader.hasMore)
        XCTAssertEqual(cursors.withValue { $0 }, [nil, "c1"])

        await loader.loadMore()
        XCTAssertEqual(cursors.withValue { $0.count }, 2, "oxiridan keyin so'rov yo'q")
    }

    func testDuplicatesAcrossPagesAreDropped() async {
        let (loader, _) = pages([
            Page(items: [Row(id: 1), Row(id: 2)], nextCursor: "c1"),
            Page(items: [Row(id: 2), Row(id: 3)], nextCursor: nil),
        ])
        await loader.reload()
        await loader.loadMore()
        XCTAssertEqual(loader.items.map(\.id), [1, 2, 3])
    }

    func testFailureKeepsLoadedItemsAndAllowsRetry() async {
        let (loader, cursors) = pages([Page(items: [Row(id: 1)], nextCursor: "c1")])
        await loader.reload()
        await loader.loadMore()
        XCTAssertEqual(loader.error, .notFound)
        XCTAssertEqual(loader.items.map(\.id), [1], "xatoda mavjud ro'yxat saqlanadi")
        XCTAssertTrue(loader.hasMore, "qayta urinish mumkin")
        XCTAssertEqual(cursors.withValue { $0 }, [nil, "c1"])
    }

    func testReloadReplacesItemsAndResetsCursor() async {
        let (loader, _) = pages([
            Page(items: [Row(id: 1)], nextCursor: "c1"),
            Page(items: [Row(id: 9)], nextCursor: nil),
        ])
        await loader.reload()
        await loader.reload()
        XCTAssertEqual(loader.items.map(\.id), [9])
        XCTAssertFalse(loader.hasMore)
    }

    func testLoadMoreBeforeFirstReloadDoesNothing() async {
        let (loader, cursors) = pages([Page(items: [Row(id: 1)], nextCursor: nil)])
        await loader.loadMore()
        XCTAssertTrue(cursors.withValue { $0.isEmpty })
    }
}
