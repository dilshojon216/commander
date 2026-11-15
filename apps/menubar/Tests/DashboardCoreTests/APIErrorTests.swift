import XCTest
@testable import DashboardCore

final class APIErrorTests: XCTestCase {
    func testStatusMapping() {
        XCTAssertEqual(APIError.from(status: 401, code: "unauthorized"), .unauthorized)
        XCTAssertEqual(APIError.from(status: 403, code: "lockdown"), .lockdown)
        XCTAssertEqual(APIError.from(status: 403, code: "insufficient_scope"), .insufficientScope)
        XCTAssertEqual(APIError.from(status: 403, code: "policy_disabled"), .forbidden(code: "policy_disabled"))
        XCTAssertEqual(APIError.from(status: 404, code: nil), .notFound)
        XCTAssertEqual(APIError.from(status: 409, code: "idempotency_conflict"), .conflict(code: "idempotency_conflict", status: nil))
        XCTAssertEqual(APIError.from(status: 409, code: "approval_conflict", bodyStatus: "approved"), .conflict(code: "approval_conflict", status: "approved"))
        XCTAssertEqual(APIError.from(status: 422, code: nil), .validation(code: nil))
        XCTAssertEqual(APIError.from(status: 400, code: "invalid_payload"), .validation(code: "invalid_payload"))
        XCTAssertEqual(APIError.from(status: 429, code: nil, retryAfter: 7), .rateLimited(retryAfter: 7))
        XCTAssertEqual(APIError.from(status: 503, code: nil), .server(status: 503))
        XCTAssertEqual(APIError.from(status: 418, code: "teapot"), .http(status: 418, code: "teapot"))
    }
}
