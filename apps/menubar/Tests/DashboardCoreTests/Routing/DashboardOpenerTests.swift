import MenuBarCore
import XCTest
@testable import DashboardCore

final class DashboardOpenerTests: XCTestCase {
    private let id = "83552025-a572-408a-8a97-2bc8d63e35cf"

    func testNativeModeAlwaysOpensNativeWindow() {
        for route in [Route.overview, .session(id), .billing, .addMachine, .admin, .helpDoc("add-server")] {
            XCTAssertEqual(DashboardOpener.destination(mode: .native, route: route), .nativeWindow(route))
        }
    }

    func testWebModeKeepsLegacyTargetsForExistingDeepLinks() {
        XCTAssertEqual(DashboardOpener.destination(mode: .web, route: .overview), .webTarget(.overview))
        XCTAssertEqual(DashboardOpener.destination(mode: .web, route: .session(id)), .webTarget(.session(id)))
        XCTAssertEqual(DashboardOpener.destination(mode: .web, route: .tokens), .webTarget(.usage))
    }

    func testWebModeOpensOtherPagesByPath() {
        XCTAssertEqual(DashboardOpener.destination(mode: .web, route: .billing), .webPath("/billing"))
        XCTAssertEqual(DashboardOpener.destination(mode: .web, route: .helpDoc("remote-control")), .webPath("/help/remote-control"))
    }

    func testWebModeFallsBackToOverviewForNativeOnlyPages() {
        XCTAssertEqual(DashboardOpener.destination(mode: .web, route: .addMachine), .webTarget(.overview))
        XCTAssertEqual(DashboardOpener.destination(mode: .web, route: .admin), .webTarget(.overview))
    }

    func testModeRawValuesAreStableForStoredSettings() {
        XCTAssertEqual(DashboardMode.native.rawValue, "native")
        XCTAssertEqual(DashboardMode.web.rawValue, "web")
        XCTAssertEqual(DashboardMode(rawValue: "native"), .native)
        XCTAssertNil(DashboardMode(rawValue: "boshqa"))
        XCTAssertEqual(Set(DashboardMode.allCases.map(\.title)).count, 2)
    }
}
