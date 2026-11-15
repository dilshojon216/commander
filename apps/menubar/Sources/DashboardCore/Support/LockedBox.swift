import Foundation

/// Qulf bilan himoyalangan o'zgaruvchan qiymat: UI'siz Core'da `Sendable` ob'yektlar ichki holat saqlashi uchun.
final class LockedBox<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()

    init(_ value: Value) { self.value = value }

    func withValue<T>(_ body: (inout Value) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}
