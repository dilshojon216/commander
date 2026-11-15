import Foundation

/// Sirpanuvchi oyna: har kalit uchun `limit` ta hodisa / `windowMs`. Soat tashqaridan beriladi (testlar uchun).
public final class RateLimiter {
    private var hits: [String: [Int64]] = [:]
    private let lock = NSLock()
    public init() {}

    /// `true` = ruxsat (hodisa hisobga olinadi). Rad etilgan urinish hisobga olinmaydi.
    public func allow(_ key: String, limit: Int, windowMs: Int64, now: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        var arr = (hits[key] ?? []).filter { $0 > now - windowMs }
        if arr.count >= limit { hits[key] = arr; return false }
        arr.append(now)
        hits[key] = arr
        return true
    }

    /// Bir nechta qoidani ATOMIK tekshiradi: hammasi o'tmasa hech biri hisobga olinmaydi.
    public func allowAll(_ rules: [(key: String, limit: Int, windowMs: Int64)], now: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        var updated: [String: [Int64]] = [:]
        for r in rules {
            let arr = (hits[r.key] ?? []).filter { $0 > now - r.windowMs }
            if arr.count >= r.limit { return false }
            updated[r.key] = arr
        }
        for r in rules { hits[r.key] = (updated[r.key] ?? []) + [now] }
        return true
    }
}

public struct SignerLimits {
    public var globalPerMinute = 240
    public var globalPerHour = 2_000
    public var perDevicePerMinute = 90
    public var rotatePerHour = 2
    public init() {}
}
