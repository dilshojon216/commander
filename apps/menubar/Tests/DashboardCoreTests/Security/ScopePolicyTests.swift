import XCTest
@testable import DashboardCore

final class ScopePolicyTests: XCTestCase {
    private let id = "00000000-0000-4000-8000-000000000001"

    func testReadOnlyTokenCannotWriteOrApprove() {
        let policy = ScopePolicy(scopes: ["read"])
        XCTAssertEqual(policy.verdict(for: Endpoints.machines()), .allowed)
        XCTAssertEqual(policy.verdict(for: Endpoints.cancelCommand(id: id)), .missingScope(.control))
        XCTAssertEqual(policy.verdict(for: Endpoints.decide(approvalId: id, body: .init(behavior: .deny))), .missingScope(.approve))
        XCTAssertFalse(policy.canControl)
        XCTAssertFalse(policy.canApprove)
    }

    func testMenuBarTokenCanApproveButNotControlUntilWidened() {
        let policy = ScopePolicy(scopes: ["read", "approve"])
        XCTAssertTrue(policy.canApprove)
        XCTAssertFalse(policy.canControl)
        XCTAssertEqual(policy.verdict(for: Endpoints.confirmCommand(id: id)), .allowed)
    }

    func testControlTokenAllowsControlEndpoints() {
        let policy = ScopePolicy(scopes: ["read", "approve", "control"])
        XCTAssertEqual(policy.verdict(for: Endpoints.dismissAlert(id: id)), .allowed)
        XCTAssertTrue(policy.canControl)
    }

    func testLockdownBlocksWritesButNotReadsOrRiskReducingActions() {
        let policy = ScopePolicy(scopes: ["read", "approve", "control"], lockdown: true)
        XCTAssertEqual(policy.verdict(for: Endpoints.machines()), .allowed, "o'qish lockdown'da ham ochiq")
        XCTAssertEqual(policy.verdict(for: Endpoints.cancelCommand(id: id)), .lockdown)
        XCTAssertEqual(policy.verdict(for: Endpoints.dismissAlert(id: id)), .allowed, "markazda @LockdownExempt")
        XCTAssertEqual(policy.verdict(for: Endpoints.decide(approvalId: id, body: .init(behavior: .deny))), .allowed)
    }

    func testMissingScopeWinsOverLockdown() {
        let policy = ScopePolicy(scopes: ["read"], lockdown: true)
        XCTAssertEqual(policy.verdict(for: Endpoints.cancelCommand(id: id)), .missingScope(.control))
    }

    func testLockdownExemptionRequiresExactShape() {
        XCTAssertTrue(ScopePolicy.isLockdownExempt(.post, ["devices", "me", "revoke"]))
        XCTAssertFalse(ScopePolicy.isLockdownExempt(.get, ["devices", "me", "revoke"]), "metod mos kelishi shart")
        XCTAssertFalse(ScopePolicy.isLockdownExempt(.post, ["devices", "me"]))
        XCTAssertFalse(ScopePolicy.isLockdownExempt(.post, ["commands"]))
        XCTAssertTrue(ScopePolicy.isLockdownExempt(.delete, ["approval-rules", "12"]))
        XCTAssertFalse(ScopePolicy.isLockdownExempt(.post, ["approval-rules", "12"]))
    }
}
