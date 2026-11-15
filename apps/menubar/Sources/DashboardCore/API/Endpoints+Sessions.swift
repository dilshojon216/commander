import CommanderContracts
import Foundation

/// Sessiyalar ro'yxati filtri (`ListSessionsQuery`).
public struct SessionsFilter: Equatable, Sendable {
    public var machine: String?
    public var project: String?
    public var status: String?
    public var activeOnly: Bool
    public var limit: Int
    public var cursor: String?

    public init(machine: String? = nil, project: String? = nil, status: String? = nil, activeOnly: Bool = false, limit: Int = 100, cursor: String? = nil) {
        self.machine = machine
        self.project = project
        self.status = status
        self.activeOnly = activeOnly
        self.limit = limit
        self.cursor = cursor
    }

    var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let machine { items.append(URLQueryItem(name: "machine", value: machine)) }
        if let project { items.append(URLQueryItem(name: "project", value: project)) }
        if let status { items.append(URLQueryItem(name: "status", value: status)) }
        if activeOnly { items.append(URLQueryItem(name: "active", value: "true")) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return items
    }
}

extension Endpoints {
    public static func sessions(_ filter: SessionsFilter = SessionsFilter()) -> Endpoint<ListSessionsResponseV1> {
        .get(["sessions"], query: filter.queryItems, cacheTTL: CacheTTL.list)
    }

    public static func session(id: String) -> Endpoint<SessionDto> {
        .get(["sessions", id])
    }

    public static func sessionEvents(id: String, limit: Int? = nil) -> Endpoint<ListSessionEventsResponseV1> {
        .get(["sessions", id, "events"], query: Self.limit(limit))
    }

    public static func sessionCommands(id: String) -> Endpoint<ListCommandsResponse> {
        .get(["sessions", id, "commands"])
    }
}
