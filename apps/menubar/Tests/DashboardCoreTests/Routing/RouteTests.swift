import MenuBarCore
import XCTest
@testable import DashboardCore

final class RouteTests: XCTestCase {
    private let id = "83552025-a572-408a-8a97-2bc8d63e35cf"

    private var everyRoute: [Route] {
        [.overview, .sessions, .session(id), .projects, .project(id), .projectWork(id), .machines, .machine(id), .addMachine,
         .alerts, .queue, .tokens, .search, .templates, .reports, .report(id), .billing, .security, .scan(id),
         .budgets, .settings, .settingsSync, .admin, .help, .helpDoc("remote-control")]
    }

    func testEveryRoutePathRoundTrips() {
        for route in everyRoute {
            XCTAssertEqual(Route(path: route.path), route, route.path)
        }
    }

    func testUsageIsAliasOfTokens() {
        XCTAssertEqual(Route(path: "/usage"), .tokens)
        XCTAssertEqual(Route.tokens.path, "/tokens")
    }

    func testAddMachineWinsOverMachineIdNamedNew() {
        XCTAssertEqual(Route(path: "/machines/new"), .addMachine)
        XCTAssertEqual(Route(path: "/machines/\(id)"), .machine(id))
    }

    func testInvalidPathsAreRejected() {
        for bad in ["", "sessions", "/nope", "/sessions/", "/sessions/a b", "/sessions/../etc", "/sessions/\(id)/extra",
                    "/help/unknown-doc", "/help/../x", "/projects/\(id)/notwork", "/sessions?x=1", "//sessions",
                    "/sessions/" + String(repeating: "a", count: 129)] {
            XCTAssertNil(Route(path: bad), "'\(bad)' rad etilishi kerak")
        }
    }

    func testWebPathExistsExceptNativeOnlyPages() {
        XCTAssertNil(Route.addMachine.webPath)
        XCTAssertNil(Route.admin.webPath)
        XCTAssertEqual(Route.session(id).webPath, "/sessions/\(id)")
        XCTAssertEqual(everyRoute.filter { $0.webPath == nil }.count, 2)
    }

    // MARK: DashboardTarget bilan moslik

    func testEveryDashboardTargetMapsToRouteWithSamePathExceptUsage() {
        let targets: [DashboardTarget] = [.overview, .session(id), .project(id), .projectWork(id), .machine(id), .alerts, .queue]
        for target in targets {
            let route = Route(target: target)
            XCTAssertEqual(route.path, target.path, "\(target)")
            XCTAssertEqual(route.dashboardTarget, target)
        }
    }

    func testUsageTargetBecomesTokensRouteAndBack() {
        XCTAssertEqual(Route(target: .usage), .tokens)
        XCTAssertEqual(Route.tokens.dashboardTarget, .usage)
    }

    func testDashboardTargetPathParsesToSameRouteAsTarget() {
        for target in [DashboardTarget.overview, .session(id), .project(id), .projectWork(id), .machine(id), .alerts, .usage, .queue] {
            XCTAssertEqual(Route(path: target.path), Route(target: target), target.path)
        }
    }

    func testRoutesWithoutLegacyTargetReturnNil() {
        XCTAssertNil(Route.billing.dashboardTarget)
        XCTAssertNil(Route.helpDoc("add-server").dashboardTarget)
    }

    // MARK: web paritet qo'riqchisi

    /// Veb'ning har bir sahifasi (`apps/dashboard/app/(app)/**/page.tsx`) uchun native marshrut bo'lishi shart.
    /// Veb'ga yangi sahifa qo'shilsa, bu test yiqiladi va native paritet vazifasini eslatadi.
    func testEveryWebPageHasANativeRoute() throws {
        let appDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("apps/dashboard/app/(app)")
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: appDir, includingPropertiesForKeys: nil))
        var pages: [String] = []
        for case let url as URL in enumerator where url.lastPathComponent == "page.tsx" {
            let relative = url.deletingLastPathComponent().path.replacingOccurrences(of: appDir.path, with: "")
            pages.append(relative.isEmpty ? "/" : relative)
        }
        XCTAssertGreaterThan(pages.count, 20, "veb sahifalari topilmadi: yo'l o'zgargan bo'lishi mumkin")

        let missing = pages.filter { page in
            let concrete = page
                .replacingOccurrences(of: "[slug]", with: "remote-control")
                .replacingOccurrences(of: #"\[[A-Za-z]+\]"#, with: id, options: .regularExpression)
            return Route(path: concrete) == nil
        }
        XCTAssertTrue(missing.isEmpty, "native marshruti yo'q veb sahifalari: \(missing.sorted())")
    }
}
