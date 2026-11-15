import Foundation

/// Xotiradagi javob keshi (diskka YOZILMAYDI: maxfiylik). Kalit = `Endpoint.cacheKey`.
public actor ResponseCache {
    public enum Lookup<Value: Sendable>: Sendable {
        /// TTL ichida: so'rovsiz beriladi.
        case fresh(Value)
        /// TTL o'tgan: ko'rsatib turiladi, fonda yangilanadi (stale-while-revalidate).
        case stale(Value)
        case miss
    }

    private struct Entry {
        let value: any Sendable
        let storedAt: Date
    }

    private var entries: [String: Entry] = [:]
    private let clock: any ClockProviding

    public init(clock: any ClockProviding = SystemClock()) {
        self.clock = clock
    }

    public func lookup<Value: Sendable>(_ key: String, ttl: TimeInterval, as type: Value.Type) -> Lookup<Value> {
        guard let entry = entries[key], let value = entry.value as? Value else { return .miss }
        return clock.now.timeIntervalSince(entry.storedAt) <= ttl ? .fresh(value) : .stale(value)
    }

    public func store(_ key: String, value: some Sendable) {
        entries[key] = Entry(value: value, storedAt: clock.now)
    }

    /// Yozuvdan keyin (yoki chiqishda/unpair) hammasi tozalanadi: eskirgan ma'lumot qolmasin.
    public func removeAll() {
        entries.removeAll()
    }

    public var count: Int { entries.count }
}
