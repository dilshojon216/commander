import CommanderContracts
import MenuBarCore
import XCTest
@testable import DashboardCore

final class SidebarModelTests: XCTestCase {
    func testBadgesOnlyForSectionsThatNeedAttention() {
        let counters = SidebarCounters(sessions: 4, pendingApprovals: 2, onlineMachines: 3, totalMachines: 5, openAlerts: 1)
        XCTAssertEqual(counters.badge(for: .sessions), 2)
        XCTAssertEqual(counters.badge(for: .alerts), 1)
        XCTAssertNil(counters.badge(for: .machines))
        XCTAssertNil(SidebarCounters().badge(for: .sessions), "0 bo'lsa belgi yo'q")
    }

    func testCountsText() {
        let counters = SidebarCounters(sessions: 4, onlineMachines: 3, totalMachines: 5, projects: 7)
        XCTAssertEqual(counters.count(for: .sessions), "4")
        XCTAssertEqual(counters.count(for: .machines), "3/5")
        XCTAssertEqual(counters.count(for: .projects), "7")
        XCTAssertNil(SidebarCounters().count(for: .machines), "mashina yo'q bo'lsa 0/0 ko'rsatilmaydi")
        XCTAssertNil(SidebarCounters().count(for: .projects), "yuklanmagan loyihalar soni ko'rsatilmaydi")
        XCTAssertNil(counters.count(for: .queue))
    }

    func testCountersFromSummaryCountOnlyActiveSessions() {
        var summary = DashboardSummary()
        summary.working = 2
        summary.waiting = 1
        summary.idle = 1
        summary.done = 9
        summary.approvals = 3
        summary.onlineMachines = 2
        summary.totalMachines = 4
        summary.openAlerts = 5
        let counters = SidebarCounters(summary: summary)
        XCTAssertEqual(counters.sessions, 4, "tugagan sessiyalar hisoblanmaydi")
        XCTAssertEqual(counters.pendingApprovals, 3)
        XCTAssertEqual(counters.openAlerts, 5)
    }

    func testLimitSummaryFromFixtureShowsEstimateHonestly() throws {
        let limits = try JSONDecoder().decode(LimitsResponse.self, from: Fixtures.data("limits"))
        let summary = try XCTUnwrap(SidebarLimitSummary(limits: limits, now: Date(timeIntervalSince1970: 1_763_092_800)))
        XCTAssertTrue(summary.percentText.hasSuffix("%"))
        XCTAssertEqual(summary.isEstimate, summary.percentText.hasPrefix("≈"), "taxmin '≈' bilan ko'rsatiladi")
        XCTAssertTrue((0...1).contains(summary.fraction))
    }

    func testLimitSummaryIsNilWithoutLimits() {
        XCTAssertNil(SidebarLimitSummary(limits: nil, now: Date()))
    }

    func testRouteTitles() {
        XCTAssertEqual(Route.overview.title, "Umumiy")
        XCTAssertEqual(Route.session("x").title, "Sessiya")
        XCTAssertEqual(Route.addMachine.title, "Mashina qo'shish")
        for section in SidebarSection.allCases { XCTAssertFalse(section.root.title.isEmpty) }
    }
}
