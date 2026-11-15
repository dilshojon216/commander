import XCTest
@testable import DashboardCore

private final class FakeVerifier: OwnerVerifying {
    private let outcome: Locked<OwnerVerification>
    private let calls = Locked(0)
    private let gate = Locked<CheckedContinuation<Void, Never>?>(nil)
    private let slow: Bool

    init(_ outcome: OwnerVerification, slow: Bool = false) {
        self.outcome = Locked(outcome)
        self.slow = slow
    }

    var callCount: Int { calls.withValue { $0 } }
    func set(_ value: OwnerVerification) { outcome.withValue { $0 = value } }
    func release() { gate.withValue { $0 }?.resume(); gate.withValue { $0 = nil } }

    func verify(reason: String) async -> OwnerVerification {
        calls.withValue { $0 += 1 }
        if slow { await withCheckedContinuation { continuation in gate.withValue { $0 = continuation } } }
        return outcome.withValue { $0 }
    }
}

final class ElevationWindowTests: XCTestCase {
    func testGrantedOpensWindowForFiveMinutesWithoutReprompting() async {
        let verifier = FakeVerifier(.granted)
        let clock = FakeClock()
        let window = ElevationWindow(verifier: verifier, clock: clock)

        let first = await window.authorize(reason: "r")
        let second = await window.authorize(reason: "r")
        XCTAssertEqual(first, .granted)
        XCTAssertEqual(second, .granted)
        XCTAssertEqual(verifier.callCount, 1, "oyna ochiq: qayta so'ramaydi")

        clock.advance(ElevationWindow.defaultDuration - 1)
        _ = await window.authorize(reason: "r")
        XCTAssertEqual(verifier.callCount, 1)

        clock.advance(2)
        _ = await window.authorize(reason: "r")
        XCTAssertEqual(verifier.callCount, 2, "5 daqiqadan keyin qayta so'raydi")
    }

    func testDeniedOrUnavailableNeverOpensWindow() async {
        let verifier = FakeVerifier(.cancelled)
        let window = ElevationWindow(verifier: verifier, clock: FakeClock())
        let cancelled = await window.authorize(reason: "r")
        XCTAssertEqual(cancelled, .cancelled)

        verifier.set(.unavailable)
        let unavailable = await window.authorize(reason: "r")
        XCTAssertEqual(unavailable, .unavailable)
        let open = await window.isOpen
        XCTAssertFalse(open)
        XCTAssertEqual(verifier.callCount, 2, "rad etilgandan keyin har urinishda qayta so'raladi")
    }

    func testRevokeClosesWindow() async {
        let verifier = FakeVerifier(.granted)
        let window = ElevationWindow(verifier: verifier, clock: FakeClock())
        _ = await window.authorize(reason: "r")
        await window.revoke()
        let open = await window.isOpen
        XCTAssertFalse(open)
        _ = await window.authorize(reason: "r")
        XCTAssertEqual(verifier.callCount, 2)
    }

    func testConcurrentRequestsShareOnePrompt() async {
        let verifier = FakeVerifier(.granted, slow: true)
        let window = ElevationWindow(verifier: verifier, clock: FakeClock())
        async let a = window.authorize(reason: "r")
        async let b = window.authorize(reason: "r")
        _ = await eventually { verifier.callCount >= 1 }
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(verifier.callCount, 1, "bir vaqtda bitta Touch ID so'rovi")
        verifier.release()
        let (ra, rb) = await (a, b)
        XCTAssertEqual(ra, .granted)
        XCTAssertEqual(rb, .granted)
    }
}
