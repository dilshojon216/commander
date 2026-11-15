import Foundation
import Observation

/// Kursorli sahifa: `nextCursor == nil` — oxiri.
public struct Page<Item: Sendable>: Sendable {
    public let items: [Item]
    public let nextCursor: String?

    public init(items: [Item], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

/// Kursorli ro'yxatni bosqichma-bosqich yuklaydi: oxiriga yetganda keyingi sahifa, takroriy so'rov bloklanadi,
/// sahifalar orasida takrorlangan id'lar tashlanadi (jonli ro'yxatda siljish bo'lishi mumkin).
@MainActor
@Observable
public final class PagedLoader<Item: Sendable & Identifiable> where Item.ID: Sendable {
    public typealias Fetch = @Sendable (_ cursor: String?) async throws(APIError) -> Page<Item>

    public private(set) var items: [Item] = []
    public private(set) var isLoading = false
    public private(set) var error: APIError?
    public private(set) var hasMore = true

    private let fetch: Fetch
    private var cursor: String?

    public init(fetch: @escaping Fetch) {
        self.fetch = fetch
    }

    /// Boshidan yuklaydi (yangilash): avvalgi natija yangi sahifa kelguncha ko'rinib turadi.
    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        error = nil
        defer { isLoading = false }
        do {
            let page = try await fetch(nil)
            items = Self.unique(page.items)
            cursor = page.nextCursor
            hasMore = page.nextCursor != nil
        } catch {
            self.error = error
        }
    }

    /// Keyingi sahifa; yuklanayotgan yoki oxiri bo'lsa hech narsa qilmaydi.
    public func loadMore() async {
        guard hasMore, !isLoading, let cursor else { return }
        isLoading = true
        error = nil
        defer { isLoading = false }
        do {
            let page = try await fetch(cursor)
            let known = Set(items.map(\.id))
            items += Self.unique(page.items).filter { !known.contains($0.id) }
            self.cursor = page.nextCursor
            hasMore = page.nextCursor != nil
        } catch {
            self.error = error
        }
    }

    private static func unique(_ list: [Item]) -> [Item] {
        var seen = Set<Item.ID>()
        return list.filter { seen.insert($0.id).inserted }
    }
}
