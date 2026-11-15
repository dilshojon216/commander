import Foundation

/// Kutish manbai: qayta ulanish/heartbeat/polling testda vaqtni kutmasdan boshqariladi.
public protocol Sleeping: Sendable {
    func sleep(for seconds: TimeInterval) async throws
}

/// Ishlab chiqarish kutishi (`Task.sleep`; bekor qilinsa xato tashlaydi).
public struct TaskSleeper: Sleeping {
    public init() {}

    public func sleep(for seconds: TimeInterval) async throws {
        try await Task.sleep(for: .seconds(seconds))
    }
}
