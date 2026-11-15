import DashboardCore

/// `OwnerVerifying` ning ishlab chiqarish adapteri: Touch ID / tizim paroli (`OwnerPresence`, LocalAuthentication).
/// Hech qanday usul yo'q bo'lsa FAIL-CLOSED (`unavailable`): tasdiq berilmaydi.
struct LocalAuthOwnerVerifier: OwnerVerifying {
    func verify(reason: String) async -> OwnerVerification {
        switch await OwnerPresence.verify(reason: reason) {
        case .ok: .granted
        case .cancelled: .cancelled
        case .unavailable: .unavailable
        }
    }
}
