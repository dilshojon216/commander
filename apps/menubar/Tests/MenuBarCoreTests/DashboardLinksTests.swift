import CommanderContracts
import MenuBarCore
import XCTest

final class DashboardLinksTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:4318")!

    // MARK: navigatsiya siyosati (ichki / tashqi)

    private func decide(_ s: String, main: Bool = true) -> DashboardNavigationPolicy.Decision {
        DashboardNavigationPolicy.decide(URL(string: s), base: base, isMainFrame: main)
    }

    func testInternalURLsStayInWebView() {
        XCTAssertEqual(decide("http://127.0.0.1:4318/"), .allow)
        XCTAssertEqual(decide("http://127.0.0.1:4318/sessions/abc?x=1#y"), .allow)
        XCTAssertEqual(decide("http://localhost:4318/projects/1/work"), .allow)
        XCTAssertEqual(decide("http://LOCALHOST:4318/"), .allow)
        XCTAssertEqual(decide("about:blank"), .allow)
        XCTAssertEqual(decide("blob:http://127.0.0.1:4318/0b1c2d3e"), .allow)
        // iframe ichida ham ichki manzil ruxsat.
        XCTAssertEqual(decide("http://127.0.0.1:4318/api/x", main: false), .allow)
    }

    func testExternalURLsOpenInBrowser() {
        XCTAssertEqual(decide("https://claude.ai/code"), .openExternally)
        XCTAssertEqual(decide("https://github.com/org/repo/pull/12"), .openExternally)
        XCTAssertEqual(decide("mailto:a@b.c"), .openExternally)
        // Boshqa port yoki sxema = boshqa origin.
        XCTAssertEqual(decide("http://127.0.0.1:4317/"), .openExternally)
        XCTAssertEqual(decide("https://127.0.0.1:4318/"), .openExternally)
        XCTAssertEqual(decide("http://127.0.0.1/"), .openExternally)
        // localhost'ga o'xshash begona domen ichki emas.
        XCTAssertEqual(decide("http://localhost.evil.com:4318/"), .openExternally)
        XCTAssertEqual(decide("http://127.0.0.1.nip.io:4318/"), .openExternally)
    }

    func testExternalSubframeDoesNotOpenBrowser() {
        XCTAssertEqual(decide("https://example.com/embed", main: false), .cancel)
        XCTAssertEqual(decide("mailto:a@b.c", main: false), .cancel)
    }

    func testDangerousSchemesBlocked() {
        XCTAssertEqual(decide("file:///etc/passwd"), .cancel)
        XCTAssertEqual(decide("javascript:alert(1)"), .cancel)
        XCTAssertEqual(decide("data:text/html,<b>x</b>"), .cancel)
        XCTAssertEqual(decide("commander://pair?c=https://x&code=1"), .cancel)
        XCTAssertEqual(decide("blob:https://evil.com/0b1c"), .cancel)
        XCTAssertEqual(decide("about:config"), .cancel)
        XCTAssertEqual(DashboardNavigationPolicy.decide(nil, base: base, isMainFrame: true), .cancel)
    }

    func testCustomBaseURL() {
        let custom = URL(string: "https://dash.example.ts.net")!
        XCTAssertEqual(DashboardNavigationPolicy.decide(URL(string: "https://dash.example.ts.net/sessions/x"), base: custom, isMainFrame: true), .allow)
        XCTAssertEqual(DashboardNavigationPolicy.decide(URL(string: "https://dash.example.ts.net:443/"), base: custom, isMainFrame: true), .allow)
        XCTAssertEqual(DashboardNavigationPolicy.decide(URL(string: "http://127.0.0.1:4318/"), base: custom, isMainFrame: true), .openExternally)
    }

    func testBaseURLSettingParse() {
        XCTAssertEqual(DashboardBaseURL.parse(" http://127.0.0.1:4318/sessions?x=1 ")?.absoluteString, "http://127.0.0.1:4318")
        XCTAssertEqual(DashboardBaseURL.parse("HTTPS://dash.example.ts.net")?.absoluteString, "https://dash.example.ts.net")
        XCTAssertNil(DashboardBaseURL.parse("ftp://127.0.0.1"))
        XCTAssertNil(DashboardBaseURL.parse("127.0.0.1:4318"))
        XCTAssertNil(DashboardBaseURL.parse("http://user:pw@127.0.0.1:4318"))
        XCTAssertNil(DashboardBaseURL.parse("javascript:alert(1)"))
        XCTAssertEqual(DashboardBaseURL.default.absoluteString, "http://127.0.0.1:4318")
    }

    // MARK: chuqur havolalar

    func testTargetPathsRoundTrip() {
        let targets: [DashboardTarget] = [.overview, .session("dad3e496-dcac-4689-87fc-4ebd4b989ad9"), .project("p1"),
                                          .projectWork("p_1"), .machine("m-1"), .alerts, .usage, .queue]
        for t in targets {
            XCTAssertEqual(DashboardTarget(path: t.path), t, t.path)
        }
        XCTAssertEqual(DashboardTarget.projectWork("abc").path, "/projects/abc/work")
        XCTAssertEqual(DashboardTarget.session("s1").url(base: base)?.absoluteString, "http://127.0.0.1:4318/sessions/s1")
        XCTAssertEqual(DashboardTarget.overview.url(base: base)?.absoluteString, "http://127.0.0.1:4318/")
    }

    func testTargetPathRejectsInjection() {
        for bad in ["", "sessions/x", "/sessions/", "/sessions/../../etc", "/sessions/a%2F..", "/sessions/a?x=1",
                    "/sessions/a/b", "//evil.com/x", "/projects/x/settings", "/unknown", "/machines/" + String(repeating: "a", count: 129),
                    "https://evil.com/sessions/x", "/sessions/a b"] {
            XCTAssertNil(DashboardTarget(path: bad), bad)
        }
    }

    func testDeepLinksFromEvents() throws {
        let approval = try Fixtures.approval()
        XCTAssertEqual(DashboardTarget.forEvent(.approvalRequested(approval)), .session("dad3e496-dcac-4689-87fc-4ebd4b989ad9"))
        let noSession = try Fixtures.patched(ApprovalDto.self, try Fixtures.object("approval"), ["sessionId": nil])
        XCTAssertEqual(DashboardTarget.forEvent(.approvalRequested(noSession)), .overview)

        let waiting = try Fixtures.session(id: "83552025-a572-408a-8a97-2bc8d63e35cf", status: "waiting")
        XCTAssertEqual(DashboardTarget.forEvent(.sessionWaiting(waiting)), .session("83552025-a572-408a-8a97-2bc8d63e35cf"))
        XCTAssertEqual(DashboardTarget.forEvent(.sessionDone(waiting)), .session("83552025-a572-408a-8a97-2bc8d63e35cf"))
        XCTAssertEqual(DashboardTarget.forEvent(.healthDegraded(machineId: "m-1", name: "srv", status: .offline)), .machine("m-1"))
        XCTAssertEqual(DashboardTarget.forEvent(.healthDegraded(machineId: "../x", name: "srv", status: .offline)), .overview)
        XCTAssertNil(DashboardTarget.forEvent(.lockdownChanged(true)))

        let alert = try Fixtures.decode(ListAlertsResponse.self, "alerts").items[0]
        XCTAssertEqual(DashboardTarget.forEvent(.alertOpened(alert)), .session(alert.sessionId))
    }

    func testNotificationAndPopupSpecsCarryTarget() throws {
        let approval = try Fixtures.approval()
        let n = EventPlanner.notification(for: .approvalRequested(approval), canApprove: true, lockdown: false)
        XCTAssertEqual(n?.target, .session("dad3e496-dcac-4689-87fc-4ebd4b989ad9"))
        // Bildirishnoma userInfo'ga yo'l yoziladi; bosilganda qayta tekshirib tiklanadi.
        XCTAssertEqual(n?.target.flatMap { DashboardTarget(path: $0.path) }, n?.target)
        let p = EventPlanner.popup(for: .approvalRequested(approval), now: Date())
        XCTAssertEqual(p?.target, .session("dad3e496-dcac-4689-87fc-4ebd4b989ad9"))

        let waiting = try Fixtures.session(id: "83552025-a572-408a-8a97-2bc8d63e35cf", status: "waiting")
        XCTAssertEqual(EventPlanner.notification(for: .sessionWaiting(waiting), canApprove: true, lockdown: false)?.target,
                       .session("83552025-a572-408a-8a97-2bc8d63e35cf"))
        XCTAssertEqual(EventPlanner.popup(for: .sessionDone(waiting), now: Date())?.target, .session("83552025-a572-408a-8a97-2bc8d63e35cf"))
        XCTAssertEqual(EventPlanner.notification(for: .healthDegraded(machineId: "m-1", name: "srv", status: .critical),
                                                 canApprove: true, lockdown: false)?.target, .machine("m-1"))
    }

    // MARK: Dock ikonkasi (activation policy)

    func testActivationPolicyFollowsWindow() {
        var s = ActivationPolicyState()
        XCTAssertEqual(s.policy, .accessory)
        XCTAssertEqual(s.windowOpened(), .regular)
        XCTAssertNil(s.windowOpened(), "ikkinchi oyna siyosatni o'zgartirmaydi")
        XCTAssertNil(s.windowClosed())
        XCTAssertEqual(s.policy, .regular)
        XCTAssertEqual(s.windowClosed(), .accessory)
        XCTAssertNil(s.windowClosed(), "ortiqcha yopilish manfiyga tushmaydi")
        XCTAssertEqual(s.openWindows, 0)
        XCTAssertEqual(s.windowOpened(), .regular)
    }
}
