import CommanderContracts
import MenuBarCore
import XCTest

final class DashboardStateTests: XCTestCase {
    private func snapshotFromFixtures() throws -> DashboardSnapshot {
        DashboardSnapshot(
            sessions: try Fixtures.decode(ListSessionsResponseV1.self, "sessions").items,
            machines: try Fixtures.decode(ListMachinesResponse.self, "machines").items,
            limits: try Fixtures.decode(LimitsResponse.self, "limits"),
            pendingApprovals: try Fixtures.decode(ListApprovalsResponse.self, "approvals").pending,
            alerts: try Fixtures.decode(ListAlertsResponse.self, "alerts").items,
            health: try Fixtures.decode(HealthSummaryResponse.self, "health-summary"),
            queue: try Fixtures.decode(ListQueueResponse.self, "queue").items
        )
    }

    func testSnapshotFromFixturesBuildsSummary() throws {
        var state = DashboardState()
        let events = state.applySnapshot(try snapshotFromFixtures())
        XCTAssertTrue(events.isEmpty, "fixture'da pending approval yo'q")
        XCTAssertTrue(state.hasSnapshot)
        let s = DashboardSummary(state: state)
        XCTAssertEqual(s.waiting, 1)
        XCTAssertEqual(s.idle, 1)
        XCTAssertEqual(s.done, 1)
        XCTAssertEqual(s.openAlerts, 2)
        XCTAssertEqual(s.activeQueue, 0)
        // health-summary.json: worst = critical (dev-macbook-pro); center RANK bilan bir xil.
        XCTAssertEqual(s.worstHealth, .critical)
        XCTAssertEqual(s.worstHealthItem?.name, "dev-macbook-pro")
        XCTAssertEqual(s.totalMachines, try Fixtures.decode(ListMachinesResponse.self, "machines").items.count)
    }

    func testSnapshotAnnouncesOnlyUnknownPendingApprovals() throws {
        var state = DashboardState()
        let a = try Fixtures.approval(id: "11111111-1111-4111-8111-111111111111")
        var snap = DashboardSnapshot(pendingApprovals: [a])
        XCTAssertEqual(state.applySnapshot(snap), [.approvalRequested(a)])
        // Qayta ulanish: o'sha approval yana kelsa takror bildirishnoma yo'q.
        XCTAssertEqual(state.applySnapshot(snap), [])
        let b = try Fixtures.approval(id: "22222222-2222-4222-8222-222222222222")
        snap.pendingApprovals = [a, b]
        XCTAssertEqual(state.applySnapshot(snap), [.approvalRequested(b)])
        // Hal bo'lgan (pending bo'lmagan) yozuvlar snapshot'da e'tiborga olinmaydi.
        let resolved = try Fixtures.approval(id: "33333333-3333-4333-8333-333333333333", status: "approved")
        snap.pendingApprovals = [resolved]
        XCTAssertEqual(state.applySnapshot(snap), [])
        XCTAssertTrue(state.pendingApprovals.isEmpty)
    }

    func testAuthOkSetsScopesAndLockdown() throws {
        var state = DashboardState()
        XCTAssertFalse(state.canApprove)
        let events = state.apply(try Fixtures.message("server-auth-ok"))
        XCTAssertEqual(events, [])
        XCTAssertTrue(state.canApprove)
        XCTAssertEqual(state.apply(try Fixtures.message("server-lockdown-updated")), [.lockdownChanged(true)])
        XCTAssertTrue(state.lockdown)
        XCTAssertEqual(state.apply(try Fixtures.message("server-lockdown-updated")), [], "o'zgarmagan holat hodisa chiqarmaydi")
    }

    func testSessionTransitionsEmitWaitingAndDone() throws {
        var state = DashboardState()
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let working = try Fixtures.session(id: id, status: "working")
        XCTAssertEqual(state.apply(try sessionMessage(working)), [])
        let waiting = try Fixtures.session(id: id, status: "waiting")
        XCTAssertEqual(state.apply(try sessionMessage(waiting)), [.sessionWaiting(waiting)])
        XCTAssertEqual(state.apply(try sessionMessage(waiting)), [], "holat o'zgarmasa hodisa yo'q")
        let now = Date()
        let done = try Fixtures.session(id: id, status: "done")
        XCTAssertEqual(state.apply(try sessionMessage(done), now: now), [.sessionDone(done)])
        XCTAssertEqual(state.recentlyDone[id], now)
        state.expireDone(now: now.addingTimeInterval(11 * 60))
        XCTAssertTrue(state.recentlyDone.isEmpty)
        let ended = try Fixtures.session(id: id, status: "ended")
        XCTAssertEqual(state.apply(try sessionMessage(ended)), [])
        XCTAssertNil(state.sessions[id], "yopilgan sessiya paneldan olib tashlanadi")
    }

    func testSessionUpdatedFixtureDecodesAndApplies() throws {
        var state = DashboardState()
        let events = state.apply(try Fixtures.message("server-session-updated"))
        XCTAssertEqual(events.count, 1)
        guard case .sessionWaiting(let s) = events[0] else { return XCTFail("waiting kutilgan") }
        XCTAssertEqual(s.projectName, "commander")
    }

    func testApprovalCreatedAndResolved() throws {
        var state = DashboardState()
        let a = try Fixtures.approval()
        let created = try Fixtures.envelope(type: "approval.created", payload: ["approval": Fixtures.json(a)])
        XCTAssertEqual(state.apply(created), [.approvalRequested(a)])
        XCTAssertEqual(DashboardSummary(state: state).approvals, 1)
        let done = try Fixtures.approval(status: "denied")
        let resolved = try Fixtures.envelope(type: "approval.resolved", payload: ["approval": Fixtures.json(done)])
        XCTAssertEqual(state.apply(resolved), [.approvalResolved(done)])
        XCTAssertTrue(state.pendingApprovals.isEmpty)
        // Fixture: approval.created lekin holat `approved` (allaqachon hal) -> karta qo'shilmaydi.
        XCTAssertEqual(state.apply(try Fixtures.message("server-approval-created")), [])
        XCTAssertTrue(state.pendingApprovals.isEmpty)
    }

    func testUnknownMessageIsIgnored() throws {
        var state = DashboardState()
        let before = state
        XCTAssertEqual(state.apply(try Fixtures.message("server-future-unknown")), [])
        XCTAssertEqual(state, before)
    }

    func testHealthDegradationEmitsOnce() throws {
        var state = DashboardState()
        state.applySnapshot(DashboardSnapshot(health: try Fixtures.decode(HealthSummaryResponse.self, "health-summary")))
        let agent = "48dada0a-c388-4478-8149-5f7349de83b7"
        let snapshot = try Fixtures.object("machine-health")["latest"] as Any
        func health(_ status: String) throws -> ServerToClientMessage {
            try Fixtures.envelope(type: "machine.health", payload: [
                "machineId": agent, "status": status, "snapshot": snapshot, "receivedAt": "2026-11-14T04:05:00.000Z",
            ])
        }
        XCTAssertEqual(state.apply(try health("warn")), [])
        XCTAssertEqual(state.apply(try health("critical")), [.healthDegraded(machineId: agent, name: "agent", status: .critical)])
        XCTAssertEqual(state.apply(try health("critical")), [])
        XCTAssertEqual(state.health[agent]?.cpuPct, 26.6, "summary raqamlari saqlanadi")
    }

    func testAlertsOpenAndResolve() throws {
        var state = DashboardState()
        let base = (try Fixtures.object("alerts")["items"] as! [[String: Any]])[0]
        let open = try Fixtures.patched(AlertDto.self, base, [:])
        XCTAssertEqual(state.apply(try Fixtures.envelope(type: "alert.created", payload: ["alert": base])), [.alertOpened(open)])
        var resolved = base
        resolved["state"] = "resolved"
        XCTAssertEqual(state.apply(try Fixtures.envelope(type: "alert.updated", payload: ["alert": resolved])), [])
        XCTAssertTrue(state.openAlerts.isEmpty)
    }

    private func sessionMessage(_ s: SessionDto) throws -> ServerToClientMessage {
        try Fixtures.envelope(type: "session.updated", payload: ["session": Fixtures.json(s)])
    }
}
