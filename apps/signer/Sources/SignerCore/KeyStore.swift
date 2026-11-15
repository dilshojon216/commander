import Foundation
import Security

/// Ed25519 maxfiy urug'i (32 bayt) saqlovi. Production: Keychain (`KeychainKeyStore`). Boshqalari faqat testlar uchun.
public protocol KeyStore: AnyObject {
    /// Urug' yoki `nil` (kalit yo'q). Boshqa xatolar (Keychain qulflangan, ACL rad etdi) `throw`.
    func loadSeed() throws -> Data?
    /// `replace == false` va kalit bor bo'lsa `KeyStoreError.exists`.
    func storeSeed(_ seed: Data, replace: Bool) throws
    func deleteSeed() throws
}

public enum KeyStoreError: Error, CustomStringConvertible, Equatable {
    case exists
    /// Keychain ACL bu binary build'ini ishonchli deb bilmaydi (binary qayta qurilgan/qayta imzolangan) yoki Keychain qulflangan.
    case aclDenied(String)
    case unavailable(String)
    public var description: String {
        switch self {
        case .exists: return "a signing key already exists in the key store"
        case .aclDenied(let m): return "the Keychain ACL does not trust this signer build (rebuilt or re-signed?) or the keychain is locked: \(m). Re-import: signer-install.sh --reimport (key still in the volume) or restore-backup"
        case .unavailable(let m): return "key store unavailable: \(m)"
        }
    }
}

public final class MemoryKeyStore: KeyStore {
    private var seed: Data?
    public init(seed: Data? = nil) { self.seed = seed }
    public func loadSeed() throws -> Data? { seed }
    public func storeSeed(_ s: Data, replace: Bool) throws {
        if seed != nil && !replace { throw KeyStoreError.exists }
        seed = s
    }
    public func deleteSeed() throws { seed = nil }
}

/// Faqat integratsiya testlari (`COMMANDER_SIGNER_TEST_KEYSTORE_DIR`): production'da ishlatilmaydi.
public final class FileKeyStore: KeyStore {
    private let path: String
    public init(path: String) { self.path = path }
    public func loadSeed() throws -> Data? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        guard let d = try? Data(contentsOf: URL(fileURLWithPath: path)) else { throw KeyStoreError.unavailable("cannot read test key file") }
        return d
    }
    public func storeSeed(_ seed: Data, replace: Bool) throws {
        if FileManager.default.fileExists(atPath: path) && !replace { throw KeyStoreError.exists }
        guard FileManager.default.createFile(atPath: path, contents: seed, attributes: [.posixPermissions: 0o600]) else { throw KeyStoreError.unavailable("cannot write test key file") }
    }
    public func deleteSeed() throws { try? FileManager.default.removeItem(atPath: path) }
}

/// macOS Keychain (login keychain), generic password: service `uz.commander.signer`.
///
/// ACL: element `SecAccess` bilan yaratiladi, ishonchli ilovalar ro'yxatida FAQAT shu binary (`SecTrustedApplicationCreateFromPath(nil)`).
/// Boshqa jarayon (`security find-generic-password -w`, boshqa ilova) o'qishga urinsa Keychain egasiga so'raydi/rad etadi;
/// daemon esa `SecKeychainSetUserInteractionAllowed(false)` bilan so'rovsiz FAIL qiladi (fail-closed). Element sinxronlanmaydi
/// (iCloud Keychain'ga tushmaydi: `kSecAttrSynchronizable` = false). Data Protection keychain ad-hoc imzoda entitlement talab
/// qiladi (errSecMissingEntitlement), shu sabab login keychain + ACL.
/// Binary qayta quriladigan bo'lsa (cdhash o'zgaradi) ACL mos kelmaydi: `signer-install.sh` qayta imzolash tartibini bajaradi.
public final class KeychainKeyStore: KeyStore {
    public static let service = "uz.commander.signer"
    public static let account = "command-signing-ed25519"
    public init() {}

    private func base() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: Self.account]
    }

    public func loadSeed() throws -> Data? {
        var q = base()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { return nil }
        if st == errSecAuthFailed || st == errSecInteractionNotAllowed { throw KeyStoreError.aclDenied(Self.message(st)) }
        guard st == errSecSuccess, let d = out as? Data else { throw KeyStoreError.unavailable("SecItemCopyMatching: \(Self.message(st))") }
        guard d.count == 32 else { throw KeyStoreError.unavailable("stored key has unexpected length") }
        return d
    }

    private func makeAccess() throws -> SecAccess {
        var app: SecTrustedApplication?
        var st = SecTrustedApplicationCreateFromPath(nil, &app)
        guard st == errSecSuccess, let app else { throw KeyStoreError.unavailable("SecTrustedApplicationCreateFromPath: \(Self.message(st))") }
        var access: SecAccess?
        st = SecAccessCreate("Commander command-signing key" as CFString, [app] as CFArray, &access)
        guard st == errSecSuccess, let access else { throw KeyStoreError.unavailable("SecAccessCreate: \(Self.message(st))") }
        return access
    }

    public func storeSeed(_ seed: Data, replace: Bool) throws {
        let existing = try loadSeed()
        if existing != nil {
            guard replace else { throw KeyStoreError.exists }
            // Mavjud element ACL'ini saqlab qiymatni yangilaydi.
            let st = SecItemUpdate(base() as CFDictionary, [kSecValueData as String: seed] as CFDictionary)
            guard st == errSecSuccess else { throw KeyStoreError.unavailable("SecItemUpdate: \(Self.message(st))") }
            return
        }
        var q = base()
        q[kSecValueData as String] = seed
        q[kSecAttrLabel as String] = "Commander command-signing key (Ed25519)"
        q[kSecAttrComment as String] = "Managed by commander-signer. Do not edit."
        q[kSecAttrSynchronizable as String] = false
        q[kSecAttrAccess as String] = try makeAccess()
        let st = SecItemAdd(q as CFDictionary, nil)
        guard st == errSecSuccess else { throw KeyStoreError.unavailable("SecItemAdd: \(Self.message(st))") }
    }

    public func deleteSeed() throws {
        let st = SecItemDelete(base() as CFDictionary)
        guard st == errSecSuccess || st == errSecItemNotFound else { throw KeyStoreError.unavailable("SecItemDelete: \(Self.message(st))") }
    }

    static func message(_ st: OSStatus) -> String {
        let m = SecCopyErrorMessageString(st, nil) as String? ?? "unknown"
        return "\(st) (\(m))"
    }

    /// Daemon rejimida hech qachon GUI so'rovini ko'rsatmaslik (ACL mos kelmasa kutib qolmaslik, fail-closed).
    public static func disableUserInteraction() { _ = SecKeychainSetUserInteractionAllowed(false) }
}
