import XCTest
@testable import DashboardCore

final class ClockProvidingTests: XCTestCase {
    func testSystemClockReturnsCurrentTime() {
        let before = Date()
        let now = SystemClock().now
        XCTAssertGreaterThanOrEqual(now, before)
        XCTAssertLessThanOrEqual(now, Date())
    }
}
