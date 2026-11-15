import CommanderContracts
import Foundation

/// Ruxsat so'rovlari, buyruqlar, avto-ruxsat qoidalari, qurilma (`approve` / `control`).
extension Endpoints {
    public static func approvals(machine: String? = nil) -> Endpoint<ListApprovalsResponse> {
        .get(["approvals"], query: machine.map { [URLQueryItem(name: "machine", value: $0)] } ?? [])
    }

    public static func approval(id: String) -> Endpoint<ApprovalDto> {
        .get(["approvals", id])
    }

    /// Qaror: faqat `approve` token (center tool/plan/question turiga qarab tanani tekshiradi).
    public static func decide(approvalId: String, body: ApprovalDecisionBody) -> Endpoint<ApprovalDecisionResponse> {
        .post(["approvals", approvalId, "decision"], body: body, scope: .approve)
    }

    public static func commands(session: String? = nil, machine: String? = nil, limit: Int? = nil) -> Endpoint<ListCommandsResponse> {
        var query = Self.limit(limit)
        if let session { query.append(URLQueryItem(name: "session", value: session)) }
        if let machine { query.append(URLQueryItem(name: "machine", value: machine)) }
        return .get(["commands"], query: query)
    }

    public static func command(id: String) -> Endpoint<CommandDto> {
        .get(["commands", id])
    }

    /// Buyruq yaratish (`control`); bir xil `idempotencyKey` + bir xil tana = o'sha buyruq.
    public static func createCommand(_ body: CreateCommandBody, idempotencyKey: String) -> Endpoint<CreateCommandResponse> {
        .post(["commands"], body: body, scope: .control, idempotencyKey: idempotencyKey)
    }

    public static func cancelCommand(id: String) -> Endpoint<EmptyResponse> {
        .post(["commands", id, "cancel"], scope: .control)
    }

    /// Ko'rib chiqish talab qilingan buyruqni dashboard'da tasdiqlash (`approve`).
    public static func confirmCommand(id: String) -> Endpoint<EmptyResponse> {
        .post(["commands", id, "confirm"], scope: .approve)
    }

    public static func approvalRules() -> Endpoint<ListApprovalRulesResponse> {
        .get(["approval-rules"])
    }

    public static func deviceMe() -> Endpoint<ClientDeviceMeResponse> {
        .get(["devices", "me"])
    }

    /// Unpair: shu qurilma tokenini bekor qiladi (lockdown'da ham ruxsat).
    public static func revokeSelf() -> Endpoint<EmptyResponse> {
        .post(["devices", "me", "revoke"], scope: .read)
    }
}
