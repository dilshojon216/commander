import CommanderContracts
import Foundation
import MenuBarCore

/// Menu-bar paneli uchun markaz amallari (`CenterClient` ustida): snapshot, qurilma ma'lumoti, unpair va ruxsat qarori.
/// Eski `CenterAPI` o'rnini bosadi; xatolar `APIError`, qaror natijasi `DecisionOutcome`.
public struct CenterService: ApprovalDecider {
    private let client: any CenterClient

    public init(client: any CenterClient) {
        self.client = client
    }

    public func me() async throws(APIError) -> ClientDeviceMeResponse {
        try await client.send(Endpoints.deviceMe())
    }

    /// Snapshot: asosiy qismlar (sessions/machines/limits/approvals) majburiy, qolganlari (alerts/health/queue) ixtiyoriy —
    /// eski markaz yoki vaqtinchalik xato butun panelni bo'sh qoldirmasin.
    public func snapshot() async throws(APIError) -> DashboardSnapshot {
        async let sessions = fetch(Endpoints.sessions(SessionsFilter(activeOnly: true, limit: 500)))
        async let machines = fetch(Endpoints.machines())
        async let limits = fetch(Endpoints.limits())
        async let approvals = fetch(Endpoints.approvals())
        async let alerts = fetch(Endpoints.alerts(openOnly: true))
        async let health = fetch(Endpoints.healthSummary())
        async let queue = fetch(Endpoints.queue())

        let required = await (sessions, machines, limits, approvals)
        let optional = await (alerts, health, queue)
        return DashboardSnapshot(
            sessions: try required.0.get().items,
            machines: try required.1.get().items,
            limits: try required.2.get(),
            pendingApprovals: try required.3.get().pending,
            alerts: (try? optional.0.get().items) ?? [],
            health: try? optional.1.get(),
            queue: (try? optional.2.get().items) ?? []
        )
    }

    /// Unpair: `POST /v1/devices/me/revoke` (lockdown'da ham ruxsat).
    public func revokeSelf() async throws(APIError) {
        let _: EmptyResponse = try await client.send(Endpoints.revokeSelf())
    }

    public func decide(approvalId: String, body: ApprovalDecisionBody) async -> DecisionOutcome {
        do {
            let response = try await client.send(Endpoints.decide(approvalId: approvalId, body: body))
            return .accepted(response.approval, delivered: response.delivered)
        } catch {
            return DecisionOutcome(error: error)
        }
    }

    private func fetch<Response>(_ endpoint: Endpoint<Response>) async -> Result<Response, APIError> {
        do throws(APIError) {
            return .success(try await client.send(endpoint))
        } catch {
            return .failure(error)
        }
    }
}

extension DecisionOutcome {
    /// Qaror so'rovi xatosi -> kartadagi ma'no (PLAN "Qarorlar 1.5-1.7", 2.14): xuddi eski HTTP status/kod jadvali.
    public init(error: APIError) {
        switch error {
        case .unauthorized, .noToken: self = .unauthorized
        case .lockdown: self = .lockdown
        case .insufficientScope: self = .noScope
        case .notFound: self = .notFound
        case .conflict(let code, let status):
            self = (code == "approval_expired" || status == "expired") ? .expired : .alreadyResolved(status: status)
        case .validation(let code) where code == "plan_approve_unsupported": self = .planApproveUnsupported
        case .rateLimited: self = .failed("Juda ko'p so'rov: birozdan keyin urinib ko'ring")
        case .offline: self = .failed("Markazga yetib bo'lmadi: \(ErrorText.message(for: error))")
        default: self = .failed(ErrorText.message(for: error))
        }
    }
}
