import XCTest
@testable import DashboardCore

@MainActor
final class NavigationModelTests: XCTestCase {
    func testNavigatePushesHistoryAndClearsForward() {
        let nav = NavigationModel()
        nav.navigate(to: .sessions)
        nav.navigate(to: .session("a"))
        XCTAssertEqual(nav.current, .session("a"))
        XCTAssertEqual(nav.backStack, [.overview, .sessions])

        XCTAssertTrue(nav.goBack())
        XCTAssertEqual(nav.current, .sessions)
        XCTAssertTrue(nav.canGoForward)

        nav.navigate(to: .machines)
        XCTAssertFalse(nav.canGoForward, "yangi sahifada oldinga steki tozalanadi")
    }

    func testBackAndForwardWalkTheHistory() {
        let nav = NavigationModel()
        nav.navigate(to: .sessions)
        nav.navigate(to: .alerts)
        XCTAssertTrue(nav.goBack())
        XCTAssertTrue(nav.goBack())
        XCTAssertEqual(nav.current, .overview)
        XCTAssertFalse(nav.goBack(), "tarix boshida orqaga yo'q")
        XCTAssertTrue(nav.goForward())
        XCTAssertTrue(nav.goForward())
        XCTAssertEqual(nav.current, .alerts)
        XCTAssertFalse(nav.goForward())
    }

    func testNavigatingToCurrentRouteDoesNotGrowHistory() {
        let nav = NavigationModel(start: .queue)
        nav.navigate(to: .queue)
        XCTAssertFalse(nav.canGoBack)
    }

    func testSelectingSectionGoesToItsRootAndUpdatesSelection() {
        let nav = NavigationModel()
        nav.navigate(to: .session("a"))
        XCTAssertEqual(nav.selectedSection, .sessions)
        nav.select(.sessions)
        XCTAssertEqual(nav.current, .sessions, "bo'limni qayta tanlash bosh sahifaga qaytaradi")
        nav.select(.machines)
        XCTAssertEqual(nav.selectedSection, .machines)
    }

    func testHistoryIsBounded() {
        let nav = NavigationModel()
        for i in 0..<(NavigationModel.maxHistory + 20) { nav.navigate(to: .session("s\(i)")) }
        XCTAssertEqual(nav.backStack.count, NavigationModel.maxHistory)
    }
}
