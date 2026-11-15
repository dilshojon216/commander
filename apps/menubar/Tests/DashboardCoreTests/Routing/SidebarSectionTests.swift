import XCTest
@testable import DashboardCore

final class SidebarSectionTests: XCTestCase {
    func testFirstNineSectionsGetCommandDigitsInOrder() {
        let digits = SidebarSection.allCases.compactMap(\.shortcutDigit)
        XCTAssertEqual(digits, Array(1...9))
        XCTAssertEqual(SidebarSection.forShortcut(digit: 1), .overview)
        XCTAssertEqual(SidebarSection.forShortcut(digit: 4), .machines)
        XCTAssertEqual(SidebarSection.forShortcut(digit: 9), .templates)
        XCTAssertNil(SidebarSection.forShortcut(digit: 0))
        XCTAssertNil(SidebarSection.forShortcut(digit: 10))
        XCTAssertNil(SidebarSection.reports.shortcutDigit)
    }

    func testEverySectionHasTitleAndRootRouteInThatSection() {
        for section in SidebarSection.allCases {
            XCTAssertFalse(section.title.isEmpty)
            XCTAssertEqual(section.root.section, section, "\(section)")
        }
        XCTAssertEqual(SidebarSection.allCases.count, 17, "yon menyuda 17 band")
    }

    func testDetailRoutesBelongToTheirSection() {
        XCTAssertEqual(Route.session("x").section, .sessions)
        XCTAssertEqual(Route.projectWork("x").section, .projects)
        XCTAssertEqual(Route.addMachine.section, .machines)
        XCTAssertEqual(Route.scan("x").section, .security)
        XCTAssertEqual(Route.helpDoc("add-server").section, .help)
    }
}
