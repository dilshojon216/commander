import XCTest
@testable import DashboardCore

final class LoadStateTests: XCTestCase {
    func testLoadedExposesValue() {
        let state = LoadState<Int>.loaded(7)
        XCTAssertEqual(state.value, 7)
        XCTAssertFalse(state.isLoading)
        XCTAssertNil(state.errorMessage)
    }

    func testFailedExposesMessageOnly() {
        let state = LoadState<Int>.failed("Aloqa yo'q")
        XCTAssertNil(state.value)
        XCTAssertEqual(state.errorMessage, "Aloqa yo'q")
    }

    func testLoadingAndIdleHaveNoValue() {
        XCTAssertTrue(LoadState<Int>.loading.isLoading)
        XCTAssertNil(LoadState<Int>.idle.value)
    }
}
