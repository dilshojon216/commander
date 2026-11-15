import CommanderContracts
import MenuBarCore
import XCTest

final class MascotMoodTests: XCTestCase {
    func testPriority() {
        var s = DashboardSummary()
        XCTAssertEqual(MascotMood.from(summary: s, connection: .live), MascotMood(pose: .mudrayapti, light: .gray, needsAttention: false))
        s.working = 3
        XCTAssertEqual(MascotMood.from(summary: s, connection: .live).light, .blue)
        XCTAssertEqual(MascotMood.from(summary: s, connection: .live).pose, .mudrayapti)
        s.recentlyDone = 1
        XCTAssertEqual(MascotMood.from(summary: s, connection: .live), MascotMood(pose: .tugatdi, light: .green, needsAttention: false))
        s.waiting = 1
        XCTAssertEqual(MascotMood.from(summary: s, connection: .live), MascotMood(pose: .kutmoqda, light: .yellow, needsAttention: true))
        s.approvals = 2
        XCTAssertEqual(MascotMood.from(summary: s, connection: .live), MascotMood(pose: .ruxsat, light: .orange, needsAttention: true))
        // Aloqa yo'qligi hammasidan ustun (eskirgan raqamga ishonib bo'lmaydi).
        let off = MascotMood.from(summary: s, connection: .reconnecting(attempt: 1, retryAt: Date()))
        XCTAssertEqual(off, MascotMood(pose: .mudrayapti, light: .red, needsAttention: true))
        XCTAssertEqual(MascotMood.from(summary: s, connection: .unauthorized(reason: "x")).light, .red)
        XCTAssertEqual(MascotMood.from(summary: s, connection: .unpaired).light, .gray)
    }

    func testMoodFromFixtureState() throws {
        var state = DashboardState()
        state.applySnapshot(DashboardSnapshot(sessions: try Fixtures.decode(ListSessionsResponseV1.self, "sessions").items))
        // sessions.json: waiting + idle + done (done snapshot'dan: "yaqinda tugadi" emas).
        XCTAssertEqual(MascotMood.from(summary: DashboardSummary(state: state), connection: .live).pose, .kutmoqda)
    }
}

final class MenuTextTests: XCTestCase {
    private var limits: LimitsResponse { get throws { try Fixtures.decode(LimitsResponse.self, "limits") } }

    func testFullFormat() throws {
        var s = DashboardSummary()
        s.working = 3
        s.waiting = 1
        let official = try LimitsResponse(computedAt: "x", freshSeconds: 180, fiveHour: nil,
                                          sevenDay: Fixtures.window("sevenDay", ["usedPct": 8.2, "source": "official", "stale": false]))
        XCTAssertEqual(MenuText.format(summary: s, limits: official, connection: .live, format: .full), "3▶ 1⏳ 8%")
        s.approvals = 2
        XCTAssertEqual(MenuText.format(summary: s, limits: official, connection: .live, format: .full), "3▶ 1⏳ 2! 8%")
        XCTAssertEqual(MenuText.format(summary: s, limits: official, connection: .live, format: .counts), "3▶ 1⏳ 2!")
        XCTAssertEqual(MenuText.format(summary: s, limits: official, connection: .live, format: .limit), "8%")
        XCTAssertEqual(MenuText.format(summary: s, limits: official, connection: .live, format: .iconOnly), "")
    }

    func testEstimateIsMarkedAndZeroCountsDropped() throws {
        // limits.json: sevenDay source=estimate (23.06) -> "≈23%"; 5h reset -> "≈0%".
        let l = try limits
        XCTAssertEqual(MenuText.format(summary: DashboardSummary(), limits: l, connection: .live, format: .full), "≈23%")
        XCTAssertEqual(MenuText.format(summary: DashboardSummary(), limits: l, connection: .live, format: .full, window: .fiveHour), "≈0%")
        XCTAssertEqual(MenuText.format(summary: DashboardSummary(), limits: l, connection: .live, format: .full, window: .highest), "≈23%")
        XCTAssertEqual(MenuText.format(summary: DashboardSummary(), limits: nil, connection: .live, format: .full), "")
    }

    func testConnectionStates() throws {
        var s = DashboardSummary()
        s.working = 1
        XCTAssertEqual(MenuText.format(summary: s, limits: try limits, connection: .reconnecting(attempt: 2, retryAt: Date()), format: .full), "⚠")
        XCTAssertEqual(MenuText.format(summary: s, limits: nil, connection: .unauthorized(reason: ""), format: .full), "⚠")
        XCTAssertEqual(MenuText.format(summary: s, limits: nil, connection: .unpaired, format: .full), "")
        XCTAssertEqual(MenuText.accessibilityLabel(summary: s, limits: try limits, connection: .live),
                       "Commander, 1 ta ishlamoqda, haftalik limit taxminan 23 foiz")
    }
}

final class LimitFormatTests: XCTestCase {
    private var cal: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Tashkent")!
        return c
    }

    func testFixtureWindows() throws {
        let l = try Fixtures.decode(LimitsResponse.self, "limits")
        let now = ContractDates.parse(l.computedAt)!
        let five = l.fiveHour!, seven = l.sevenDay!
        XCTAssertEqual(LimitFormat.percent(five), "≈0%")
        XCTAssertEqual(LimitFormat.note(five, now: now), "yangilandi")
        XCTAssertEqual(LimitFormat.percent(seven), "≈23%")
        XCTAssertEqual(LimitFormat.note(seven, now: now), "3 daqiqa oldin kuzatilgan")
        // Fixture bashorati: beforeReset=false -> "tugaydi" ko'rsatilmaydi, reset vaqti ko'rsatiladi.
        XCTAssertNil(LimitFormat.forecast(seven, now: now))
        XCTAssertEqual(LimitFormat.resetText(seven, now: now, calendar: cal), "ertaga 18:00 da yangilanadi")
    }

    func testForecastBeforeReset() throws {
        let now = ContractDates.parse("2026-11-14T08:00:00.000Z")! // 13:00 Toshkent
        let forecast: [String: Any] = [
            "exhaustsAt": "2026-11-14T10:40:00.000Z", "beforeReset": true, "resetsAt": "2026-11-14T12:00:00.000Z",
            "ratePctPerHour": 12.5, "basisMinutes": 30, "basisWeightedTokens": 1000, "confidence": "high", "source": "official",
        ]
        let w = try Fixtures.window("fiveHour", ["forecast": forecast, "reset": false, "source": "official", "usedPct": 66.0])
        XCTAssertEqual(LimitFormat.forecast(w, now: now, calendar: cal), "≈ 15:40 da tugaydi")
        XCTAssertEqual(LimitFormat.percent(w), "66%")
        XCTAssertEqual(LimitFormat.forecast(w, now: ContractDates.parse("2026-11-14T11:00:00.000Z")!, calendar: cal), "≈ tugagan bo'lishi mumkin")
    }

    func testLevelsAndClock() throws {
        XCTAssertEqual(LimitFormat.level(try Fixtures.window("sevenDay", ["usedPct": 79.9])), .normal)
        XCTAssertEqual(LimitFormat.level(try Fixtures.window("sevenDay", ["usedPct": 80])), .warn)
        XCTAssertEqual(LimitFormat.level(try Fixtures.window("sevenDay", ["usedPct": 96])), .critical)
        let now = ContractDates.parse("2026-11-14T08:00:00.000Z")!
        XCTAssertEqual(LimitFormat.clock(ContractDates.parse("2026-11-16T22:03:00.000Z")!, now: now, calendar: cal), "17.11 03:03")
        XCTAssertEqual(LimitFormat.relative(from: now.addingTimeInterval(-7200), to: now), "2 soat oldin")
        XCTAssertEqual(LimitFormat.relative(from: now.addingTimeInterval(-10), to: now), "hozirgina")
    }

    func testForecastWatcherNotifiesOncePerWindow() throws {
        let now = ContractDates.parse("2026-11-14T08:00:00.000Z")!
        func limits(exhausts: String) throws -> LimitsResponse {
            let f: [String: Any] = [
                "exhaustsAt": exhausts, "beforeReset": true, "resetsAt": "2026-11-14T12:00:00.000Z",
                "ratePctPerHour": 20, "basisMinutes": 30, "basisWeightedTokens": 1, "confidence": "medium", "source": "estimate",
            ]
            return LimitsResponse(computedAt: "x", freshSeconds: 180,
                                  fiveHour: try Fixtures.window("fiveHour", ["forecast": f, "reset": false]), sevenDay: nil)
        }
        var watcher = LimitForecastWatcher(lead: 3600)
        XCTAssertNil(watcher.check(try limits(exhausts: "2026-11-14T09:30:00.000Z"), now: now), "90 daqiqa: hali erta")
        let spec = watcher.check(try limits(exhausts: "2026-11-14T08:40:00.000Z"), now: now)
        XCTAssertEqual(spec?.category, .limit)
        XCTAssertTrue(spec?.body.contains("taxmin") ?? false)
        XCTAssertNil(watcher.check(try limits(exhausts: "2026-11-14T08:30:00.000Z"), now: now), "bir oyna uchun bir marta")
    }
}

final class GroupingAndTextTests: XCTestCase {
    func testProjectGroupsAttentionFirst() throws {
        let sessions = [
            try Fixtures.session(id: "1", status: "idle", project: "alpha"),
            try Fixtures.session(id: "2", status: "working", project: "beta"),
            try Fixtures.session(id: "3", status: "waiting", project: "gamma"),
            try Fixtures.session(id: "4", status: "working", project: "gamma"),
        ]
        let g = ProjectGroup.group(sessions)
        XCTAssertEqual(g.map(\.name), ["gamma", "beta", "alpha"])
        XCTAssertEqual(g[0].counts.map(\.status), [.waiting, .working])
    }

    func testApprovalSummaryTruncatesAndPlan() throws {
        let a = try Fixtures.approval()
        XCTAssertTrue(ApprovalText.summary(a).hasPrefix("Bash: "))
        let long = try Fixtures.patched(ApprovalDto.self, Fixtures.object("approval"), ["toolInputRedacted": String(repeating: "x", count: 500)])
        XCTAssertEqual(ApprovalText.summary(long, max: 50).count, 50)
        let plan = try Fixtures.approval(kind: "plan", plan: "## Reja\n1. Qadam")
        XCTAssertEqual(ApprovalText.summary(plan), "Reja: ## Reja")
        XCTAssertEqual(ApprovalText.project(plan), "Brain")
        let now = ContractDates.parse("2026-11-14T08:00:00.000Z")!
        let soon = try Fixtures.approval(deadline: now.addingTimeInterval(252))
        XCTAssertEqual(ApprovalText.remaining(soon, now: now), "4:12")
    }

    func testEventPlannerCategories() throws {
        let tool = try Fixtures.approval()
        let plan = try Fixtures.approval(kind: "plan", plan: "x")
        XCTAssertEqual(EventPlanner.notification(for: .approvalRequested(tool), canApprove: true, lockdown: false)?.category, .approval)
        XCTAssertEqual(EventPlanner.notification(for: .approvalRequested(tool), canApprove: true, lockdown: true)?.category, .approvalDenyOnly)
        XCTAssertEqual(EventPlanner.notification(for: .approvalRequested(plan), canApprove: true, lockdown: false)?.category, .approvalDenyOnly)
        XCTAssertEqual(EventPlanner.notification(for: .approvalRequested(tool), canApprove: false, lockdown: false)?.category, .approvalReadOnly)
        XCTAssertEqual(EventPlanner.notification(for: .approvalRequested(tool), canApprove: true, lockdown: false)?.approvalId, tool.id)
        let named = EventPlanner.notification(for: .approvalRequested(tool), canApprove: true, lockdown: false, machineNames: [tool.machineId: "dev-macbook-pro"])
        XCTAssertTrue(named?.body.hasPrefix("dev-macbook-pro · Bash") ?? false, "uzun slug o'rniga mashina nomi")
        XCTAssertNil(EventPlanner.notification(for: .sessionDone(try Fixtures.session(status: "done")), canApprove: true, lockdown: false))
        XCTAssertNil(EventPlanner.popup(for: .approvalRequested(tool), now: Date())?.autoHide, "ruxsat pop-up hal bo'lguncha turadi")
        XCTAssertEqual(EventPlanner.popup(for: .sessionDone(try Fixtures.session(status: "done")), now: Date())?.pose, .tugatdi)
        XCTAssertEqual(EventPlanner.popup(for: .sessionWaiting(try Fixtures.session(status: "waiting")), now: Date())?.autoHide, 8)
    }
}
