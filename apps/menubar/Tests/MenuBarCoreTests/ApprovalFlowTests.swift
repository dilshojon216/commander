import CommanderContracts
import MenuBarCore
import XCTest

final class DecisionOutcomeTests: XCTestCase {
    private func body(_ o: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: o) }

    func testAccepted() throws {
        let a = try Fixtures.approval(status: "denied")
        let resp = body(["approval": try Fixtures.json(a), "delivered": false, "idempotent": false])
        let o = DecisionOutcome.from(status: 200, body: resp)
        XCTAssertEqual(o, .accepted(a, delivered: false))
        XCTAssertNotNil(o.message, "yetkazilmagan qaror haqida xabar")
        XCTAssertTrue(o.removesCard)
    }

    func testLockdown403KeepsCard() {
        let o = DecisionOutcome.from(status: 403, body: body(["error": "lockdown", "message": "Lockdown is active"]))
        XCTAssertEqual(o, .lockdown)
        XCTAssertFalse(o.removesCard, "lockdown'da approval pending qoladi: rad etish hamon mumkin")
        XCTAssertEqual(o.message, "Lockdown: faqat rad etish mumkin")
    }

    func testScope403() {
        XCTAssertEqual(DecisionOutcome.from(status: 403, body: body(["error": "insufficient_scope", "message": "Required scope: approve"])), .noScope)
    }

    func testConflict409() {
        let conflict = DecisionOutcome.from(status: 409, body: body(["error": "approval_conflict", "message": "x", "status": "approved"]))
        XCTAssertEqual(conflict, .alreadyResolved(status: "approved"))
        XCTAssertTrue(conflict.removesCard)
        XCTAssertEqual(conflict.message, "Allaqachon hal qilingan (terminalda javob berildi)")
        XCTAssertEqual(DecisionOutcome.from(status: 409, body: body(["error": "approval_expired", "message": "x", "status": "expired"])), .expired)
        XCTAssertEqual(DecisionOutcome.from(status: 409, body: body(["error": "approval_conflict", "message": "x", "status": "expired"])), .expired)
    }

    func testOtherStatuses() {
        XCTAssertEqual(DecisionOutcome.from(status: 422, body: body(["error": "plan_approve_unsupported", "message": "x"])), .planApproveUnsupported)
        XCTAssertEqual(DecisionOutcome.from(status: 401, body: body(["error": "unauthorized", "message": "x"])), .unauthorized)
        XCTAssertEqual(DecisionOutcome.from(status: 404, body: Data()), .notFound)
        XCTAssertEqual(DecisionOutcome.from(status: 500, body: Data()), .failed("Xato 500"))
        XCTAssertEqual(DecisionOutcome.from(status: 200, body: Data("{}".utf8)), .failed("Javobni o'qib bo'lmadi"))
    }
}

final class ApprovalFlowTests: XCTestCase {
    func testActionsByScopeKindAndLockdown() throws {
        let tool = try Fixtures.approval()
        let plan = try Fixtures.approval(kind: "plan", plan: "reja")
        let ro = ApprovalActions.compute(tool, canApprove: false, lockdown: false)
        XCTAssertFalse(ro.showAllow)
        XCTAssertFalse(ro.showDeny)
        XCTAssertNotNil(ro.readOnlyReason)
        let normal = ApprovalActions.compute(tool, canApprove: true, lockdown: false)
        XCTAssertTrue(normal.showAllow && normal.showDeny)
        XCTAssertNil(normal.allowDisabledReason)
        XCTAssertFalse(normal.showDenyWithFeedback)
        let locked = ApprovalActions.compute(tool, canApprove: true, lockdown: true)
        XCTAssertEqual(locked.allowDisabledReason, "Lockdown: faqat rad etish mumkin")
        XCTAssertTrue(locked.showDeny)
        let p = ApprovalActions.compute(plan, canApprove: true, lockdown: false)
        XCTAssertFalse(p.showAllow, "reja: masofadan tasdiq yo'q (PLAN 2.14)")
        XCTAssertTrue(p.showDenyWithFeedback)
    }

    func testAllowRequiresInlineConfirm() throws {
        let a = try Fixtures.approval()
        let actions = ApprovalActions.compute(a, canApprove: true, lockdown: false)
        var flow = ApprovalFlow()
        XCTAssertNil(flow.begin(a.id, behavior: .allow, message: nil, actions: actions), "birinchi bosish faqat tasdiq so'raydi")
        XCTAssertEqual(flow.phase(a.id), .confirmingAllow)
        let body = flow.begin(a.id, behavior: .allow, message: nil, actions: actions)
        XCTAssertEqual(body, ApprovalDecisionBody(behavior: .allow))
        XCTAssertEqual(flow.phase(a.id), .submitting(.allow))
        XCTAssertNil(flow.begin(a.id, behavior: .deny, message: nil, actions: actions), "yuborilayotganda ikkinchi qaror yo'q")
    }

    func testNotificationAllowSkipsInlineConfirm() throws {
        let a = try Fixtures.approval()
        var flow = ApprovalFlow()
        let body = flow.begin(a.id, behavior: .allow, message: nil, actions: ApprovalActions.compute(a, canApprove: true, lockdown: false), requireConfirm: false)
        XCTAssertEqual(body?.behavior, .allow)
    }

    func testLockdownBlocksAllowButNotDeny() throws {
        let a = try Fixtures.approval()
        let actions = ApprovalActions.compute(a, canApprove: true, lockdown: true)
        var flow = ApprovalFlow()
        flow.tapAllow(a.id)
        XCTAssertNil(flow.begin(a.id, behavior: .allow, message: nil, actions: actions))
        XCTAssertEqual(flow.phase(a.id), .error("Lockdown: faqat rad etish mumkin"))
        XCTAssertEqual(flow.begin(a.id, behavior: .deny, message: nil, actions: actions)?.behavior, .deny)
    }

    func testPlanDenyWithFeedbackTrimsAndCaps() throws {
        let plan = try Fixtures.approval(kind: "plan", plan: "reja")
        let actions = ApprovalActions.compute(plan, canApprove: true, lockdown: false)
        var flow = ApprovalFlow()
        XCTAssertNil(flow.begin(plan.id, behavior: .allow, message: nil, actions: actions), "reja allow yuborilmaydi")
        flow.startFeedback(plan.id)
        let long = "  " + String(repeating: "a", count: 1500) + "  "
        let body = flow.begin(plan.id, behavior: .deny, message: long, actions: actions)
        XCTAssertEqual(body?.behavior, .deny)
        XCTAssertEqual(body?.message?.count, ApprovalFlow.maxMessageLength)
        var flow2 = ApprovalFlow()
        XCTAssertNil(flow2.begin(plan.id, behavior: .deny, message: "   ", actions: actions)?.message, "bo'sh izoh yuborilmaydi")
    }

    func testFinishPhases() throws {
        let a = try Fixtures.approval()
        var flow = ApprovalFlow()
        flow.finish(a.id, outcome: .accepted(a, delivered: true))
        XCTAssertEqual(flow.phase(a.id), .idle)
        flow.finish(a.id, outcome: .lockdown)
        XCTAssertEqual(flow.phase(a.id), .error("Lockdown: faqat rad etish mumkin"))
        flow.finish(a.id, outcome: .alreadyResolved(status: "approved"))
        XCTAssertEqual(flow.phase(a.id), .error("Allaqachon hal qilingan (terminalda javob berildi)"))
    }

    /// To'liq oqim soxta decider bilan: 409 -> karta olib tashlanadi, 403 lockdown -> qoladi va lockdown yoqiladi.
    func testFlowWithFakeDecider() async throws {
        struct Fake: ApprovalDecider {
            let outcome: DecisionOutcome
            func decide(approvalId: String, body: ApprovalDecisionBody) async -> DecisionOutcome { outcome }
        }
        let a = try Fixtures.approval()
        var state = DashboardState()
        state.applySnapshot(DashboardSnapshot(pendingApprovals: [a]))
        state.scopes = ["read", "approve"]
        var flow = ApprovalFlow()

        // 1) deny -> 409 conflict
        let body = flow.begin(a.id, behavior: .deny, message: nil, actions: ApprovalActions.compute(a, canApprove: state.canApprove, lockdown: state.lockdown))!
        let o1 = await Fake(outcome: .alreadyResolved(status: "approved")).decide(approvalId: a.id, body: body)
        flow.finish(a.id, outcome: o1)
        if o1.removesCard { state.dropApproval(id: a.id) }
        XCTAssertTrue(state.pendingApprovals.isEmpty)

        // 2) allow -> 403 lockdown
        state.applySnapshot(DashboardSnapshot(pendingApprovals: [a]))
        let actions = ApprovalActions.compute(a, canApprove: true, lockdown: state.lockdown)
        flow.tapAllow(a.id)
        let b2 = flow.begin(a.id, behavior: .allow, message: nil, actions: actions)!
        let o2 = await Fake(outcome: .lockdown).decide(approvalId: a.id, body: b2)
        flow.finish(a.id, outcome: o2)
        XCTAssertEqual(state.markLockdown(true), [.lockdownChanged(true)])
        XCTAssertFalse(o2.removesCard)
        XCTAssertEqual(state.pendingApprovals.count, 1)
        XCTAssertEqual(ApprovalActions.compute(a, canApprove: true, lockdown: state.lockdown).allowDisabledReason, "Lockdown: faqat rad etish mumkin")
    }
}
