import CommanderContracts
import Foundation

/// Umumiy ko'rinish, mashinalar, limitlar, salomatlik (o'qish; `read`).
extension Endpoints {
    public static func machines() -> Endpoint<ListMachinesResponse> {
        .get(["machines"], cacheTTL: CacheTTL.list)
    }

    public static func machineHealth(machineId: String) -> Endpoint<MachineHealthResponse> {
        .get(["machines", machineId, "health"], cacheTTL: CacheTTL.list)
    }

    public static func projects() -> Endpoint<ListProjectsResponse> {
        .get(["projects"], cacheTTL: CacheTTL.list)
    }

    public static func limits() -> Endpoint<LimitsResponse> {
        .get(["limits"], cacheTTL: CacheTTL.list)
    }

    public static func usageSummary() -> Endpoint<UsageSummaryResponse> {
        .get(["usage", "summary"], cacheTTL: CacheTTL.list)
    }

    public static func healthSummary() -> Endpoint<HealthSummaryResponse> {
        .get(["health", "summary"], cacheTTL: CacheTTL.list)
    }

    public static func centerHealth() -> Endpoint<CenterHealthResponse> {
        .get(["center", "health"], cacheTTL: CacheTTL.list)
    }

    public static func queue(limit: Int? = nil) -> Endpoint<ListQueueResponse> {
        .get(["queue"], query: Self.limit(limit), cacheTTL: CacheTTL.list)
    }

    public static func alerts(openOnly: Bool = true, limit: Int? = nil) -> Endpoint<ListAlertsResponse> {
        .get(["alerts"], query: [URLQueryItem(name: "state", value: openOnly ? "open" : "all")] + Self.limit(limit), cacheTTL: CacheTTL.list)
    }

    /// Ogohlantirishni yopish (`control`).
    public static func dismissAlert(id: String) -> Endpoint<EmptyResponse> {
        .post(["alerts", id, "dismiss"], scope: .control)
    }
}
