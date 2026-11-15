import XCTest
@testable import DashboardCore

final class PollingStreamTests: XCTestCase {
    func testYieldsResultsAndErrorsWithoutStoppingThenStopsOnCancel() async {
        let sleeper = ManualSleeper()
        let calls = Locked(0)
        let polling = PollingStream<Int>(interval: 1, sleeper: sleeper) { () throws(APIError) -> Int in
            let n = calls.withValue { $0 += 1; return $0 }
            if n == 2 { throw .offline }
            return n
        }
        let results = Locked<[Result<Int, APIError>]>([])
        let reader = Task { for await result in polling.stream() { results.withValue { $0.append(result) } } }

        _ = await eventually { results.withValue { $0.count } == 1 }
        await sleeper.releaseAll()
        _ = await eventually { results.withValue { $0.count } == 2 }
        await sleeper.releaseAll()
        _ = await eventually { results.withValue { $0.count } == 3 }

        let all = results.withValue { $0 }
        XCTAssertEqual(all[0], .success(1))
        XCTAssertEqual(all[1], .failure(.offline), "xato oqimga keladi va polling to'xtamaydi")
        XCTAssertEqual(all[2], .success(3))

        reader.cancel()
        await sleeper.releaseAll()
        let before = calls.withValue { $0 }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(calls.withValue { $0 }, before, "oqim bekor qilingach so'rov yo'q")
    }

    func testRequestedIntervalIsPassedToSleeper() async {
        let sleeper = ManualSleeper()
        let polling = PollingStream<Int>(interval: 2.5, sleeper: sleeper) { () throws(APIError) -> Int in 1 }
        let reader = Task { for await _ in polling.stream() {} }
        _ = await eventually { await sleeper.requested == [2.5] }
        let requested = await sleeper.requested
        XCTAssertEqual(requested, [2.5])
        reader.cancel()
    }
}
