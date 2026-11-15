import MenuBarCore
import XCTest
@testable import DashboardCore

final class ConnectionBadgeTests: XCTestCase {
    func testLiveIsGoodAndPulsing() {
        let badge = ConnectionBadge(.live)
        XCTAssertEqual(badge.title, "Jonli")
        XCTAssertEqual(badge.tone, .good)
        XCTAssertTrue(badge.pulsing)
    }

    func testReconnectingIsWarningWithoutPulse() {
        let badge = ConnectionBadge(.reconnecting(attempt: 2, retryAt: Date()))
        XCTAssertEqual(badge.tone, .warning)
        XCTAssertFalse(badge.pulsing)
    }

    func testRejectedTokenIsDanger() {
        XCTAssertEqual(ConnectionBadge(.unauthorized(reason: "401")).tone, .danger)
    }

    func testUnpairedAndConnectingAreNeutral() {
        XCTAssertEqual(ConnectionBadge(.unpaired).tone, .neutral)
        XCTAssertEqual(ConnectionBadge(.connecting).tone, .neutral)
    }
}
