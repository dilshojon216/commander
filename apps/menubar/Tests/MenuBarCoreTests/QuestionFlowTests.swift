import CommanderContracts
import MenuBarCore
import XCTest

final class QuestionFlowTests: XCTestCase {
    private func question(_ qs: [[String: Any]]) throws -> ApprovalDto {
        try Fixtures.patched(ApprovalDto.self, Fixtures.object("approval"), [
            "kind": "question", "status": "pending", "behavior": nil, "decidedAt": nil, "decidedByDeviceId": nil, "resolvedAt": nil,
            "questions": qs,
        ])
    }

    private func q(_ text: String, multi: Bool = false, labels: [String] = ["A", "B (Recommended)", "C"]) -> [String: Any] {
        ["question": text, "header": "H", "multiSelect": multi,
         "options": labels.map { ["label": $0, "description": "d-\($0)"] }]
    }

    func testLabelHelpers() {
        XCTAssertTrue(QuestionFlow.isRecommendedLabel("Redis (Recommended)"))
        XCTAssertFalse(QuestionFlow.isRecommendedLabel("Redis"))
        XCTAssertEqual(QuestionFlow.displayOptionLabel("Redis (Recommended)"), "Redis (tavsiya)")
        XCTAssertEqual(QuestionFlow.displayOptionLabel("Redis"), "Redis")
    }

    func testEligibility() throws {
        XCTAssertTrue(QuestionFlow.isSingleSelectSingleQuestion(try question([q("x")])))
        XCTAssertFalse(QuestionFlow.isSingleSelectSingleQuestion(try question([q("x", multi: true)])))
        XCTAssertFalse(QuestionFlow.isSingleSelectSingleQuestion(try question([q("x"), q("y")])))
        XCTAssertFalse(QuestionFlow.isSingleSelectSingleQuestion(try Fixtures.approval()))
    }

    func testButtonsAndBody() throws {
        let a = try question([q("x")])
        let b = QuestionFlow.buttons(for: a)
        XCTAssertEqual(b.map(\.title), ["A", "B (tavsiya)", "C"])
        XCTAssertEqual(b.map(\.isRecommended), [false, true, false])
        let body = try XCTUnwrap(QuestionFlow.answerBody(for: a, optionIndex: 2))
        XCTAssertEqual(body.behavior, .allow)
        XCTAssertEqual(body.answers?.count, 1)
        XCTAssertEqual(body.answers?.first?.q, 0)
        XCTAssertEqual(body.answers?.first?.picks, [2], "indeks, label emas; tavsiya avto-tanlanmaydi")
        XCTAssertNil(QuestionFlow.answerBody(for: a, optionIndex: 3))
        XCTAssertNil(QuestionFlow.answerBody(for: a, optionIndex: -1))
        XCTAssertTrue(QuestionFlow.buttons(for: try question([q("x"), q("y")])).isEmpty)
        XCTAssertNil(QuestionFlow.answerBody(for: try question([q("x", multi: true)]), optionIndex: 0))
    }

    func testActionsAndFlow() throws {
        let a = try question([q("x")])
        let act = ApprovalActions.compute(a, canApprove: true, lockdown: false)
        XCTAssertFalse(act.showAllow, "oddiy Ruxsat yo'q: markaz 422 qaytaradi")
        XCTAssertTrue(act.showDeny)
        var f = ApprovalFlow()
        XCTAssertNil(f.beginAnswer(a.id, approval: a, optionIndex: 0, canApprove: false, lockdown: false))
        XCTAssertNil(f.beginAnswer(a.id, approval: a, optionIndex: 0, canApprove: true, lockdown: true))
        XCTAssertEqual(f.phase(a.id), .error("Lockdown: faqat rad etish mumkin"))
        let body = f.beginAnswer(a.id, approval: a, optionIndex: 1, canApprove: true, lockdown: false)
        XCTAssertEqual(body?.answers?.first?.picks, [1])
        XCTAssertEqual(f.phase(a.id), .submitting(.allow))
        XCTAssertNil(f.beginAnswer(a.id, approval: a, optionIndex: 1, canApprove: true, lockdown: false), "ikki marta yuborilmaydi")
    }

    func testNotificationHasNoApproveForQuestion() throws {
        let a = try question([q("x")])
        let spec = EventPlanner.notification(for: .approvalRequested(a), canApprove: true, lockdown: false, machineNames: [:])
        XCTAssertEqual(spec?.category, .approvalDenyOnly)
    }
}
