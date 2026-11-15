import Foundation

/// Vaqt manbai: view model va servislar `Date()` ni to'g'ridan-to'g'ri chaqirmaydi, shuning uchun testda soat boshqariladi.
public protocol ClockProviding: Sendable {
    var now: Date { get }
}

/// Ishlab chiqarish soati.
public struct SystemClock: ClockProviding {
    public init() {}
    public var now: Date { Date() }
}
