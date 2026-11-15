import CommanderContracts
import Foundation
import MenuBarCore
import XCTest

final class PaceFormatTests: XCTestCase {
    private func pace(_ patch: [String: Any?] = [:]) throws -> WeeklyPace {
        var o: [String: Any] = [
            "dayStartPct": 20.0, "dayStartFrom": "prev_sample", "allowancePct": 18.0, "usedTodayPct": 9.8, "pctOfAllowance": 54.4,
            "expectedPct": 50.0, "currentPct": 29.8, "onTrack": true, "status": "on_track", "exhaustAt": NSNull(), "exhaustBeforeReset": NSNull(),
            "resetsAt": "2026-11-15T13:00:00.000Z", "windowStartsAt": "2026-11-08T13:00:00.000Z", "dayStartsAt": "2026-11-11T19:00:00.000Z",
            "remainingDays": 4.44, "source": "official", "stale": false, "enabled": true, "softPct": 80.0, "hardPct": 100.0, "enforce": false,
            "overriddenToday": false, "blocked": false, "alertsToday": ["soft": NSNull(), "hard": NSNull()],
        ]
        for (k, v) in patch { o[k] = v ?? NSNull() }
        return try JSONDecoder().decode(WeeklyPace.self, from: JSONSerialization.data(withJSONObject: o))
    }

    private var cal: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Tashkent")!
        return c
    }

    func testShareOfficialUsesCommaAndNoApprox() throws {
        let p = try pace()
        XCTAssertEqual(PaceFormat.share(p), "9,8% / 18,0% (54%)")
        XCTAssertEqual(PaceFormat.statusText(p), "rejada")
        XCTAssertEqual(PaceFormat.compactLine(p), "Bugun 9,8% / 18,0% (54%) · rejada")
        XCTAssertNil(PaceFormat.note(p))
        XCTAssertFalse(PaceFormat.isEstimate(p))
    }

    func testEstimateIsNeverShownAsOfficial() throws {
        let p = try pace(["source": "estimate", "stale": true])
        XCTAssertEqual(PaceFormat.share(p), "≈9,8% / ≈18,0% (54%)")
        XCTAssertEqual(PaceFormat.note(p), "taxmin")
        XCTAssertTrue(PaceFormat.isEstimate(p))
        XCTAssertTrue(PaceFormat.accessibility(p, now: Date(), calendar: cal).contains("taxminan"))
    }

    func testStaleOfficialNote() throws {
        XCTAssertEqual(PaceFormat.note(try pace(["stale": true])), "kuzatuv eskirgan")
    }

    func testStatusLevelsAndBar() throws {
        let fast = try pace(["status": "fast", "onTrack": false, "pctOfAllowance": 85.0])
        XCTAssertEqual(PaceFormat.statusText(fast), "tez ketmoqda")
        XCTAssertEqual(PaceFormat.level(fast), .warn)
        let over = try pace(["status": "exceeded", "onTrack": false, "pctOfAllowance": 140.0])
        XCTAssertEqual(PaceFormat.statusText(over), "ulush tugadi")
        XCTAssertEqual(PaceFormat.level(over), .critical)
        XCTAssertEqual(PaceFormat.barPct(over), 100)
        XCTAssertEqual(PaceFormat.barPct(try pace(["pctOfAllowance": -3.0])), 0)
        XCTAssertEqual(PaceFormat.level(try pace()), .normal)
    }

    func testForecast() throws {
        let now = ContractDates.parse("2026-11-13T12:00:00.000Z")! // 17:00 Toshkent
        XCTAssertNil(PaceFormat.forecast(try pace(), now: now, calendar: cal))
        let today = try pace(["exhaustAt": "2026-11-13T15:00:00.000Z", "exhaustBeforeReset": true])
        XCTAssertEqual(PaceFormat.forecast(today, now: now, calendar: cal), "shu tezlikda 20:00 da tugaydi")
        let tomorrow = try pace(["exhaustAt": "2026-11-13T20:00:00.000Z", "exhaustBeforeReset": true])
        XCTAssertEqual(PaceFormat.forecast(tomorrow, now: now, calendar: cal), "shu tezlikda ertaga 01:00 da tugaydi")
        let est = try pace(["source": "estimate", "exhaustAt": "2026-11-13T15:00:00.000Z", "exhaustBeforeReset": true])
        XCTAssertEqual(PaceFormat.forecast(est, now: now, calendar: cal), "≈ shu tezlikda 20:00 da tugaydi")
        let safe = try pace(["exhaustAt": "2026-11-20T00:00:00.000Z", "exhaustBeforeReset": false])
        XCTAssertEqual(PaceFormat.forecast(safe, now: now, calendar: cal), "shu tezlikda hafta oxirigacha yetadi")
        let past = try pace(["exhaustAt": "2026-11-13T11:00:00.000Z", "exhaustBeforeReset": true])
        XCTAssertEqual(PaceFormat.forecast(past, now: now, calendar: cal), "shu tezlikda hozir tugayapti")
    }

    func testGateNotes() throws {
        XCTAssertNil(PaceFormat.gateNote(try pace()))
        XCTAssertEqual(PaceFormat.gateNote(try pace(["overriddenToday": true])), "bugun uchun ruxsat berilgan")
        XCTAssertEqual(PaceFormat.gateNote(try pace(["blocked": true, "enforce": true])), "yangi sessiyalar kechiktirilmoqda")
    }

    func testLimitsResponseWithAndWithoutPaceDecodes() throws {
        let base = try Fixtures.decode(LimitsResponse.self, "limits")
        XCTAssertNil(base.pace) // eski center: pace yo'q
        let withPace = LimitsResponse(computedAt: base.computedAt, freshSeconds: base.freshSeconds, fiveHour: base.fiveHour, sevenDay: base.sevenDay, pace: try pace())
        let data = try JSONEncoder().encode(withPace)
        XCTAssertEqual(try JSONDecoder().decode(LimitsResponse.self, from: data).pace?.status, .onTrack)
    }
}
