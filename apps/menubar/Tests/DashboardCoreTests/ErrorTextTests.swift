import XCTest
@testable import DashboardCore

final class ErrorTextTests: XCTestCase {
    func testCommandTextsComeFromWebTable() {
        XCTAssertEqual(ErrorText.command(code: "machine_offline"), "Mashina oflayn")
        XCTAssertEqual(ErrorText.command(code: "lockdown"), "Lockdown yoqiq: boshqaruv o'chirilgan")
        XCTAssertEqual(ErrorText.command(code: "step_up_expired"), "Tasdiqlash vaqti tugadi (2 daqiqa)")
        XCTAssertTrue(ErrorText.hasCommandText(for: "deploy_busy"), "deploy jadvali ham kiradi")
        XCTAssertTrue(ErrorText.hasCommandText(for: "config_not_allowed"), "config jadvali ham kiradi")
        XCTAssertTrue(ErrorText.hasCommandText(for: "logs_not_found"), "log jadvali ham kiradi")
        XCTAssertTrue(ErrorText.hasCommandText(for: "git_failed"), "git jadvali ham kiradi")
    }

    func testUnknownOrMissingCodeFallsBackToGenericText() {
        XCTAssertEqual(ErrorText.command(code: nil), "Buyruq bajarilmadi")
        XCTAssertEqual(ErrorText.command(code: ""), "Buyruq bajarilmadi")
        XCTAssertEqual(ErrorText.command(code: "future_code_v9"), "Buyruq bajarilmadi (future_code_v9)")
    }

    func testMessageForEveryErrorIsNonEmptyUzbekText() {
        let all: [APIError] = [
            .unauthorized, .lockdown, .insufficientScope, .forbidden(code: nil), .notFound, .conflict(code: nil, status: nil),
            .validation(code: nil), .rateLimited(retryAfter: nil), .server(status: 500), .http(status: 418, code: nil),
            .offline, .decoding("X"), .invalidRequest("URL"), .noToken,
        ]
        for error in all { XCTAssertFalse(ErrorText.message(for: error).isEmpty, "\(error)") }
    }

    func testKnownCodesOverrideGenericMessages() {
        XCTAssertEqual(ErrorText.message(for: .conflict(code: "idempotency_conflict", status: nil)), "Bu so'rov allaqachon boshqa ma'lumot bilan yuborilgan")
        XCTAssertEqual(ErrorText.message(for: .forbidden(code: "policy_disabled")), "Bu mashinada masofaviy boshqaruv o'chiq")
        XCTAssertEqual(ErrorText.message(for: .conflict(code: "unknown_x", status: nil)), "Bu amalni hozir bajarib bo'lmaydi (holat o'zgargan)")
    }

    func testRateLimitedMentionsWaitTime() {
        XCTAssertTrue(ErrorText.message(for: .rateLimited(retryAfter: 7.2)).contains("8 soniya"))
        XCTAssertFalse(ErrorText.message(for: .rateLimited(retryAfter: nil)).contains("soniya"))
    }

    func testGatewayErrorsReadAsConnectivity() {
        XCTAssertEqual(ErrorText.message(for: .server(status: 503)), "Markazga ulanib bo'lmadi")
        XCTAssertEqual(ErrorText.message(for: .server(status: 500)), "Markaz xatosi (500)")
    }
}
