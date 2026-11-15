import Foundation

public enum OwnerVerification: Sendable, Equatable {
    case granted
    case cancelled
    /// Touch ID/parol imkoni yo'q (parolsiz Mac...): FAIL-CLOSED, tasdiq berilmaydi.
    case unavailable
}

/// Egasini lokal tasdiqlash (Touch ID yoki tizim paroli). Ilova qatlamida `LocalAuthentication` adapteri bor; testda soxta.
public protocol OwnerVerifying: Sendable {
    func verify(reason: String) async -> OwnerVerification
}

/// Muvaffaqiyatli tasdiqdan keyin `duration` (5 daqiqa) davomida qayta so'ramaydi; bir vaqtdagi so'rovlar bitta oynaga birlashadi.
public actor ElevationWindow {
    public static let defaultDuration: TimeInterval = 5 * 60

    private let verifier: any OwnerVerifying
    private let clock: any ClockProviding
    private let duration: TimeInterval
    private var openUntil: Date?
    private var inFlight: Task<OwnerVerification, Never>?

    public init(verifier: any OwnerVerifying, clock: any ClockProviding = SystemClock(), duration: TimeInterval = ElevationWindow.defaultDuration) {
        self.verifier = verifier
        self.clock = clock
        self.duration = duration
    }

    public var isOpen: Bool {
        guard let openUntil else { return false }
        return clock.now < openUntil
    }

    /// Oyna ochiq bo'lsa so'ramasdan `granted`; aks holda tasdiq so'raydi va muvaffaqiyatda oynani ochadi.
    public func authorize(reason: String) async -> OwnerVerification {
        if isOpen { return .granted }
        if let inFlight { return await inFlight.value }
        let task = Task { [verifier] in await verifier.verify(reason: reason) }
        inFlight = task
        let result = await task.value
        inFlight = nil
        if result == .granted { openUntil = clock.now.addingTimeInterval(duration) }
        return result
    }

    /// Oynani yopadi (unpair, ekran qulflanganda, lockdown yoqilganda).
    public func revoke() {
        openUntil = nil
    }
}
