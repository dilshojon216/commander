import Foundation
import XCTest
@testable import CommanderContracts

/// clients/fixtures/*.json: jonli center'dan olingan (tozalangan) REST javoblari va WS namunalari.
/// Hammasi dekodlanadi, qayta kodlanadi va yana dekodlanganda teng bo'lishi shart.
final class FixtureDecodingTests: XCTestCase {
    private static let fixturesDir: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("fixtures")

    private func data(_ name: String) throws -> Data {
        try Data(contentsOf: Self.fixturesDir.appendingPathComponent("\(name).json"))
    }

    private func roundTrip<T: Codable & Hashable>(_ type: T.Type, _ name: String, file: StaticString = #filePath, line: UInt = #line) throws -> T {
        let decoder = JSONDecoder()
        let value = try decoder.decode(T.self, from: data(name))
        let again = try decoder.decode(T.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(value, again, "\(name) round-trip", file: file, line: line)
        return value
    }

    func testRestFixturesDecode() throws {
        _ = try roundTrip(ListMachinesResponse.self, "machines")
        _ = try roundTrip(ListSessionsResponseV1.self, "sessions")
        _ = try roundTrip(ListSessionEventsResponseV1.self, "session-events")
        _ = try roundTrip(ListProjectsResponse.self, "projects")
        _ = try roundTrip(ProjectDetailDto.self, "project-detail")
        _ = try roundTrip(ProjectTasksResponse.self, "project-tasks")
        _ = try roundTrip(ListProjectCommitsResponse.self, "project-commits")
        _ = try roundTrip(UsageSummaryResponse.self, "usage-summary")
        _ = try roundTrip(UsageResponse.self, "usage-series")
        _ = try roundTrip(LimitsResponse.self, "limits")
        _ = try roundTrip(ListApprovalsResponse.self, "approvals")
        _ = try roundTrip(ApprovalDto.self, "approval")
        _ = try roundTrip(ListQueueResponse.self, "queue")
        _ = try roundTrip(ListAlertsResponse.self, "alerts")
        _ = try roundTrip(HealthSummaryResponse.self, "health-summary")
        _ = try roundTrip(MachineHealthResponse.self, "machine-health")
        _ = try roundTrip(ListTemplatesResponse.self, "templates")
        _ = try roundTrip(ListOrchestrationsResponse.self, "orchestrations")
        _ = try roundTrip(ListTasksResponse.self, "tasks")
    }

    /// Native dashboard (docs/NATIVE-DASHBOARD.md, N0.4): qo'shimcha REST javoblari. Namunalar soxta (placeholder) ma'lumotli.
    func testNativeDashboardRestFixturesDecode() throws {
        let detail = try roundTrip(SessionDto.self, "session-detail")
        XCTAssertEqual(detail.status, .waiting)

        let commands = try roundTrip(ListCommandsResponse.self, "commands")
        XCTAssertEqual(commands.items.count, 4)
        XCTAssertTrue(commands.items[1].stepUp.required)
        XCTAssertEqual(commands.items[1].review?.required, true)
        XCTAssertEqual(commands.items[2].errorCode, "agent_offline")
        XCTAssertNil(commands.items[0].review)

        let rules = try roundTrip(ListApprovalRulesResponse.self, "approval-rules")
        XCTAssertEqual(rules.rules.map(\.status), [.active, .revoked])

        let alerts = try roundTrip(ListAlertsResponse.self, "alerts-all")
        XCTAssertEqual(alerts.items.map(\.state), [.open, .resolved, .dismissed])

        let budgets = try roundTrip(BudgetsResponse.self, "budgets")
        XCTAssertEqual(budgets.items.map(\.state), [.ok, .soft])
        XCTAssertEqual(budgets.items[1].effectiveLimit, 1_250_000)

        let health = try roundTrip(CenterHealthResponse.self, "center-health")
        XCTAssertEqual(health.status, .warn)
        XCTAssertEqual(health.incidents.count, 1)
        XCTAssertEqual(health.checks.last?.status, .disabled)

        let pace = try roundTrip(PaceSettingsResponse.self, "pace-settings")
        XCTAssertEqual(pace.settings.hardPct, 100)
        XCTAssertFalse(pace.overriddenToday)

        let exemption = try roundTrip(StepUpExemptionResponse.self, "stepup-exemption")
        XCTAssertTrue(exemption.available)
        XCTAssertFalse(exemption.exempt)
    }

    /// N1.12/N2.13-15/N3.8: admin CLI `--json` chiqishlari, mashina arxivi/nomi, audit va salomatlik chegaralari (soxta ma'lumot).
    func testAdminCliAndMachineAdminFixturesDecode() throws {
        let enroll = try roundTrip(AdminEnrollCodeOutput.self, "admin-enroll-code-output")
        XCTAssertEqual(enroll.kind, "agentd")
        let codes = try roundTrip(AdminEnrollCodeList.self, "admin-enroll-code-list")
        XCTAssertEqual(codes.items.map(\.state), [.pending, .used, .expired])
        _ = try roundTrip(AdminTokenIssued.self, "admin-token-issued")
        let rotated = try roundTrip(AdminTokenRotated.self, "admin-token-rotated")
        XCTAssertNil(rotated.expiresAt)
        XCTAssertFalse(rotated.stepupExemptInherited)
        let tokens = try roundTrip(AdminTokenList.self, "admin-token-list")
        XCTAssertEqual(tokens.items.map(\.state), [.active, .revoked, .expired])
        let devices = try roundTrip(AdminDeviceList.self, "admin-device-list")
        XCTAssertEqual(devices.items[0].machineId, "11111111-1111-4111-8111-111111111111")
        XCTAssertNil(devices.items[1].machineId)
        XCTAssertTrue(devices.items[0].rotationRequired)
        XCTAssertEqual(devices.items.map(\.state), [.active, .revoked])
        let pair = try roundTrip(AdminPairOutput.self, "admin-pair-output")
        XCTAssertEqual(pair.scopes, [.read, .approve])
        let lock = try roundTrip(AdminLockdownStatus.self, "admin-lockdown-status")
        XCTAssertTrue(lock.enabled)
        let tg = try roundTrip(AdminTelegramList.self, "admin-telegram-list")
        XCTAssertEqual(tg.items.map(\.source), [.env, .db])
        let pending = try roundTrip(AdminTelegramPending.self, "admin-telegram-pending")
        XCTAssertEqual(pending.items[0].atMs, 1_763_200_000_000)
        XCTAssertNil(pending.items[1].username)
        let key = try roundTrip(AdminCenterKeyShow.self, "admin-center-key-show")
        XCTAssertEqual(key.overlap.count, 1)

        let audit = try roundTrip(ListAuditResponse.self, "audit-list")
        XCTAssertEqual(audit.nextBefore, "41")
        XCTAssertEqual(audit.items.map(\.action), ["machine.renamed", "lockdown.changed"])
        let thresholds = try roundTrip(HealthThresholdsResponse.self, "health-thresholds")
        XCTAssertEqual(thresholds.defaults.diskWarnPct, 85)
        _ = try roundTrip(PutHealthThresholdsBody.self, "ws/put-health-thresholds-body")

        let archived = try roundTrip(MachineDto.self, "machine-archived")
        XCTAssertEqual(archived.archivedAt, "2026-11-15T10:00:00.000Z")
        // Eski center javobi (archivedAt yo'q) ham dekodlanadi.
        let legacy = try roundTrip(ListMachinesResponse.self, "machines")
        XCTAssertNil(legacy.items.first?.archivedAt)
        let resp = try roundTrip(MachineArchiveResponse.self, "machine-archive-response")
        XCTAssertEqual(resp.archivedAt, "2026-11-15T10:00:00.000Z")
        let body = try roundTrip(UpdateMachineBody.self, "ws/update-machine-body")
        XCTAssertEqual(body.displayName, "Example Mac")
    }

    func testNativeDashboardWsFixturesDecode() throws {
        guard case .commandUpdated(let updated) = try roundTrip(ServerToClientMessage.self, "ws/server-command-updated") else { return XCTFail("command.updated") }
        XCTAssertEqual(updated.payload.command.status, .running)

        guard case .chatState(let state) = try roundTrip(ServerToClientMessage.self, "ws/server-chat-state") else { return XCTFail("chat.state") }
        XCTAssertEqual(state.payload.state, .live)

        guard case .chatItems(let older) = try roundTrip(ServerToClientMessage.self, "ws/server-chat-items-older") else { return XCTFail("chat.items") }
        XCTAssertEqual(older.payload.older, true)
        XCTAssertEqual(older.payload.cursor, "cur-0123")
        XCTAssertEqual(older.payload.items.count, 2)

        guard case .chatOpen(let open) = try roundTrip(ClientToServerMessage.self, "ws/client-chat-open") else { return XCTFail("chat.open") }
        XCTAssertEqual(open.payload.limit, 50)
        XCTAssertNil(open.payload.before)
        guard case .chatOpen(let page) = try roundTrip(ClientToServerMessage.self, "ws/client-chat-open-older") else { return XCTFail("chat.open before") }
        XCTAssertEqual(page.payload.before, "cur-0123")
        guard case .chatClose = try roundTrip(ClientToServerMessage.self, "ws/client-chat-close") else { return XCTFail("chat.close") }
    }

    func testSessionFields() throws {
        let list = try roundTrip(ListSessionsResponseV1.self, "sessions")
        let s = try XCTUnwrap(list.items.first)
        XCTAssertEqual(s.status, .waiting)
        XCTAssertEqual(s.notificationType, "permission_prompt")
        XCTAssertNil(s.endedAt)
        XCTAssertTrue(s.controllable)
        XCTAssertNotNil(ContractDates.parse(s.startedAt))
    }

    func testLimitsSourceIsExplicit() throws {
        let l = try roundTrip(LimitsResponse.self, "limits")
        XCTAssertEqual(l.freshSeconds, 180)
        // CLAUDE.md qoidasi 6: har oyna `source` bilan keladi (official | estimate)
        let five = try XCTUnwrap(l.fiveHour)
        XCTAssertTrue([LimitSource.official, .estimate].contains(five.source))
    }

    func testUnknownEnumValueDoesNotCrash() throws {
        var json = try JSONSerialization.jsonObject(with: data("sessions")) as! [String: Any]
        var items = json["items"] as! [[String: Any]]
        items[0]["status"] = "teleporting_v9"
        json["items"] = items
        let list = try JSONDecoder().decode(ListSessionsResponseV1.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(list.items[0].status, .unknown("teleporting_v9"))
        // qayta kodlanganda xom qiymat saqlanadi
        let again = try JSONEncoder().encode(list)
        XCTAssertTrue(String(decoding: again, as: UTF8.self).contains("teleporting_v9"))
    }

    func testServerMessages() throws {
        func decode(_ name: String) throws -> ServerToClientMessage { try roundTrip(ServerToClientMessage.self, "ws/\(name)") }

        guard case .authOk(let ok) = try decode("server-auth-ok") else { return XCTFail("auth.ok") }
        XCTAssertEqual(ok.payload.scopes, [.read, .approve])
        XCTAssertFalse(ok.payload.lockdown.enabled)
        XCTAssertNil(ok.payload.lockdown.since)

        guard case .sessionUpdated(let su) = try decode("server-session-updated") else { return XCTFail("session.updated") }
        XCTAssertEqual(su.payload.session.status, .waiting)

        guard case .usageTick(let tick) = try decode("server-usage-tick") else { return XCTFail("usage.tick") }
        XCTAssertEqual(tick.payload.total.requests, 3)
        XCTAssertEqual(tick.payload.byProject.first?.projectId, nil)
        XCTAssertEqual(try XCTUnwrap(tick.payload.total.costUsd), 0.4321, accuracy: 1e-9)

        guard case .lockdownUpdated(let ld) = try decode("server-lockdown-updated") else { return XCTFail("lockdown") }
        XCTAssertTrue(ld.payload.enabled)

        guard case .approvalCreated = try decode("server-approval-created") else { return XCTFail("approval.created") }
        guard case .limitsUpdated = try decode("server-limits-updated") else { return XCTFail("limits.updated") }
        guard case .machineUpdated = try decode("server-machine-updated") else { return XCTFail("machine.updated") }
        guard case .pong = try decode("server-pong") else { return XCTFail("pong") }
        guard case .subscribed = try decode("server-subscribed") else { return XCTFail("subscribed") }
        guard case .error(let err) = try decode("server-error") else { return XCTFail("error") }
        XCTAssertEqual(err.payload.code, .rateLimited)
    }

    func testFutureServerMessageDecodesAsUnknown() throws {
        let m = try roundTrip(ServerToClientMessage.self, "ws/server-future-unknown")
        guard case .unknown(let type, let raw) = m else { return XCTFail("unknown bo'lishi kerak") }
        XCTAssertEqual(type, "something.from.the.future")
        XCTAssertEqual(raw["payload"]?["hello"]?.stringValue, "world")
        XCTAssertEqual(m.type, "something.from.the.future")
    }

    func testChatItemsAllKindsAndFutureKind() throws {
        guard case .chatItems(let msg) = try roundTrip(ServerToClientMessage.self, "ws/server-chat-items") else { return XCTFail("chat.items") }
        let items = msg.payload.items
        XCTAssertEqual(items.count, 8)
        guard case .user(let u) = items[0] else { return XCTFail("user") }
        XCTAssertEqual(u.variant, .prompt)
        guard case .assistant(let a) = items[1] else { return XCTFail("assistant") }
        XCTAssertEqual(a.model, "sonnet")
        guard case .thinking = items[2] else { return XCTFail("thinking") }
        guard case .toolUse(let t) = items[3] else { return XCTFail("tool_use") }
        XCTAssertEqual(t.lines?.added, 3)
        guard case .toolResult(let r) = items[4] else { return XCTFail("tool_result") }
        XCTAssertTrue(r.ok)
        guard case .notice(let n) = items[5] else { return XCTFail("notice") }
        XCTAssertEqual(n.code, .info)
        guard case .usage(let us) = items[6] else { return XCTFail("usage") }
        XCTAssertEqual(us.cacheReadTokens, 300)
        guard case .unknown(let kind, _) = items[7] else { return XCTFail("future kind") }
        XCTAssertEqual(kind, "future_kind_v9")
        XCTAssertEqual(msg.payload.replace, true)
        XCTAssertNil(msg.payload.cursor) // required-nullable emas: `null` ham yo'q ham nil
    }

    func testClientMessagesEncodeToWireShape() throws {
        let sub = ClientSubscribeMessage(
            id: "00000000-0000-4000-8000-000000000011", ts: 1_763_092_800_000,
            payload: ClientSubscribePayload(channels: [.sessions, .approvals, .limits]))
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sub)) as! [String: Any]
        XCTAssertEqual(wire["type"] as? String, "subscribe")
        XCTAssertEqual(wire["v"] as? Int, 1)
        XCTAssertEqual((wire["payload"] as? [String: Any])?["channels"] as? [String], ["sessions", "approvals", "limits"])

        _ = try roundTrip(ClientToServerMessage.self, "ws/client-auth")
        _ = try roundTrip(ClientToServerMessage.self, "ws/client-subscribe")
        _ = try roundTrip(ClientToServerMessage.self, "ws/client-ping")
    }

    func testRequestBodiesEncodeOnlyWhatIsSet() throws {
        let start = CreateCommandBodySessionStart(machineId: "00000000-0000-4000-8000-000000000001", cwd: "/tmp/x", prompt: "go", permissionMode: .acceptEdits)
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(CreateCommandBody.sessionStart(start))) as! [String: Any]
        XCTAssertEqual(wire["type"] as? String, "session.start")
        XCTAssertEqual(wire["permissionMode"] as? String, "acceptEdits")
        XCTAssertNil(wire["name"], "ixtiyoriy maydon yozilmaydi")

        _ = try roundTrip(CreateCommandBody.self, "ws/create-command-start")
        _ = try roundTrip(CreateCommandBody.self, "ws/create-command-prompt")
        _ = try roundTrip(ApprovalDecisionBody.self, "ws/approval-decision-body")
    }

    func testPairingTypes() throws {
        let body = try roundTrip(ClientPairBody.self, "ws/pair-body")
        XCTAssertEqual(body.platform, "ios")
        XCTAssertNil(body.publicKey)
        let res = try roundTrip(ClientPairResponse.self, "ws/pair-response")
        XCTAssertTrue(res.token.hasPrefix(CommanderContract.clientTokenPrefix))
        XCTAssertEqual(res.kind, .mobile)
        let me = try roundTrip(ClientDeviceMeResponse.self, "ws/device-me")
        XCTAssertFalse(me.stepUpExempt)
        XCTAssertNil(me.lastUsedAt)
    }

    func testPairingURLAndSubprotocols() throws {
        let p = try XCTUnwrap(PairingURL.parse("commander://pair?c=https%3A%2F%2Fmac.tail1234.ts.net&code=ABCDE-FGHJK&fp=sha256%3Aabc"))
        XCTAssertEqual(p.centerURL.absoluteString, "https://mac.tail1234.ts.net")
        XCTAssertEqual(p.code, "ABCDE-FGHJK")
        XCTAssertEqual(p.fingerprint, "sha256:abc")
        XCTAssertNil(PairingURL.parse("commander://pair?c=http%3A%2F%2Fevil.example&code=X"), "http (loopback emas) rad etiladi")
        XCTAssertNotNil(PairingURL.parse("commander://pair?c=http%3A%2F%2F127.0.0.1%3A4317&code=X"))
        XCTAssertNil(PairingURL.parse("https://pair?c=https%3A%2F%2Fa.b&code=X"))
        XCTAssertEqual(ClientWebSocketAuth.subprotocols(token: "cmdr_t"), ["commander.v1", "cmdr-token.cmdr_t"])
    }

    func testDates() {
        XCTAssertNotNil(ContractDates.parse("2026-11-14T04:00:28.445Z"))
        XCTAssertNotNil(ContractDates.parse("2026-11-14T04:00:28Z"))
        XCTAssertNil(ContractDates.parse("yesterday"))
        XCTAssertEqual(ContractDates.format(ContractDates.parse("2026-11-14T04:00:28.445Z")!), "2026-11-14T04:00:28.445Z")
    }
}
