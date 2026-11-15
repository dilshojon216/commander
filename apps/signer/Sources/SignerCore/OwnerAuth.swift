import Foundation
import LocalAuthentication

/// Egasining mavjudligini tasdiqlash (Touch ID yoki hisob paroli). Kalitni eksport/tiklash/o'chirish kabi xavfli amallar uchun:
/// binary ACL'da ishonchli bo'lgani uchun uni IXTIYORIY jarayon ishga tushira oladi; shu darvoza o'sha jarayonni to'xtatadi.
public protocol OwnerAuth {
    func confirm(reason: String) -> Bool
}

public struct AllowAllOwnerAuth: OwnerAuth { public init() {}; public func confirm(reason: String) -> Bool { true } }
public struct DenyAllOwnerAuth: OwnerAuth { public init() {}; public func confirm(reason: String) -> Bool { false } }

public struct LocalAuthOwnerAuth: OwnerAuth {
    public init() {}
    public func confirm(reason: String) -> Bool {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { return false }
        let sem = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var ok = false
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in ok = success; sem.signal() }
        _ = sem.wait(timeout: .now() + 120)
        return ok
    }
}
