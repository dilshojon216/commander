import XCTest
@testable import DashboardCore

final class ResponseCacheTests: XCTestCase {
    func testFreshThenStaleThenMissAfterClear() async {
        let clock = FakeClock()
        let cache = ResponseCache(clock: clock)
        await cache.store("k", value: 42)

        guard case .fresh(let v1) = await cache.lookup("k", ttl: 30, as: Int.self) else { return XCTFail("fresh") }
        XCTAssertEqual(v1, 42)

        clock.advance(31)
        guard case .stale(let v2) = await cache.lookup("k", ttl: 30, as: Int.self) else { return XCTFail("stale") }
        XCTAssertEqual(v2, 42)

        await cache.removeAll()
        guard case .miss = await cache.lookup("k", ttl: 30, as: Int.self) else { return XCTFail("miss") }
        let count = await cache.count
        XCTAssertEqual(count, 0)
    }

    func testWrongTypeIsMissNotCrash() async {
        let cache = ResponseCache(clock: FakeClock())
        await cache.store("k", value: "matn")
        guard case .miss = await cache.lookup("k", ttl: 30, as: Int.self) else { return XCTFail("miss") }
    }

    func testBoundaryTTLIsStillFresh() async {
        let clock = FakeClock()
        let cache = ResponseCache(clock: clock)
        await cache.store("k", value: 1)
        clock.advance(30)
        guard case .fresh = await cache.lookup("k", ttl: 30, as: Int.self) else { return XCTFail("fresh") }
    }
}
