import XCTest
@testable import DashboardCore

/// Web `elevationFor` / `classifyProxyRequest` / `elevationRequired` ning HAQIQIY natijalari (`scripts/gen-elevation-rules.mjs`)
/// bilan solishtirish: qoida ikki tomonda ajralib ketsa test yiqiladi.
final class ElevationPolicyTests: XCTestCase {
    private struct Case: Decodable {
        let method: String
        let path: String
        let body: [String: String]?
        let elevation: String
        let required: Bool
        let allowed: Bool
        let scope: String?
    }

    private func corpus() throws -> [Case] {
        try JSONDecoder().decode([Case].self, from: Fixtures.localData("elevation-corpus.json"))
    }

    private func method(_ raw: String) throws -> HTTPMethod {
        try XCTUnwrap(HTTPMethod(rawValue: raw))
    }

    func testAllGeneratedRulesCompile() {
        XCTAssertTrue(ElevationPolicy.allRulesCompiled)
    }

    func testCorpusIsLargeEnoughToMeanSomething() throws {
        let cases = try corpus()
        XCTAssertGreaterThan(cases.count, 300)
        XCTAssertEqual(Set(cases.map(\.elevation)), ["none", "required", "decision", "command"], "to'rtala daraja qamrab olingan")
    }

    func testElevationLevelMatchesWebForEveryCorpusCase() throws {
        var mismatches: [String] = []
        for c in try corpus() {
            let level = ElevationPolicy.elevation(method: try method(c.method), segments: c.path.components(separatedBy: "/"))
            if level.rawValue != c.elevation { mismatches.append("\(c.method) \(c.path): native=\(level.rawValue) web=\(c.elevation)") }
        }
        XCTAssertTrue(mismatches.isEmpty, mismatches.prefix(10).joined(separator: "\n"))
    }

    func testRequirementWithBodyMatchesWeb() throws {
        var mismatches: [String] = []
        for c in try corpus() {
            let level = ElevationPolicy.elevation(method: try method(c.method), segments: c.path.components(separatedBy: "/"))
            let body = try c.body.map { try JSONSerialization.data(withJSONObject: $0) }
            if ElevationPolicy.isRequired(level, body: body) != c.required { mismatches.append("\(c.method) \(c.path) \(c.body ?? [:])") }
        }
        XCTAssertTrue(mismatches.isEmpty, mismatches.prefix(10).joined(separator: "\n"))
    }

    // MARK: asosiy qoidalar (o'qiladigan misollar)

    func testDenyNeedsNoConfirmationButAllowDoes() {
        let id = "00000000-0000-4000-8000-000000000001"
        let deny = Endpoints.decide(approvalId: id, body: .init(behavior: .deny))
        let allow = Endpoints.decide(approvalId: id, body: .init(behavior: .allow))
        XCTAssertFalse(ElevationPolicy.isRequired(for: deny))
        XCTAssertTrue(ElevationPolicy.isRequired(for: allow))
    }

    func testMalformedDecisionIdFailsClosed() {
        let notUUID = Endpoints.decide(approvalId: "a1", body: .init(behavior: .deny))
        XCTAssertTrue(ElevationPolicy.isRequired(for: notUUID), "UUID bo'lmagan yo'l qoidaga mos kelmaydi: fail-closed")
    }

    func testReadsNeverNeedConfirmation() {
        XCTAssertEqual(ElevationPolicy.elevation(method: .get, segments: ["sessions"]), .none)
        XCTAssertFalse(ElevationPolicy.isRequired(for: Endpoints.machines()))
    }

    func testCancelAndDismissAreExemptButUnknownWritesFailClosed() {
        XCTAssertEqual(ElevationPolicy.elevation(method: .post, segments: ["commands", "u", "cancel"]), .required, "uuid shakli bo'lmasa istisna emas")
        XCTAssertFalse(ElevationPolicy.isRequired(for: Endpoints.cancelCommand(id: "00000000-0000-4000-8000-000000000001")))
        XCTAssertFalse(ElevationPolicy.isRequired(for: Endpoints.dismissAlert(id: "00000000-0000-4000-8000-000000000001")))
        XCTAssertEqual(ElevationPolicy.elevation(method: .post, segments: ["never", "heard", "of", "it"]), .required)
        XCTAssertEqual(ElevationPolicy.elevation(method: .delete, segments: ["something-new"]), .required)
    }

    func testUnreadableBodyForDecisionFailsClosed() {
        XCTAssertTrue(ElevationPolicy.isRequired(.decision, body: nil))
        XCTAssertTrue(ElevationPolicy.isRequired(.decision, body: Data("not json".utf8)))
        XCTAssertTrue(ElevationPolicy.isRequired(.command, body: nil))
    }
}
