import Foundation
import Darwin
import SignerCore

// commander-signer: markaz buyruq-imzo kalitini Keychain'da saqlovchi host xizmat (H-02). Kalit materiali HECH QACHON chop etilmaydi.

let usage = """
Usage: commander-signer <command> [options]
  serve [--state-dir D] [--tcp-port 4320] [--unix PATH]   daemon (launchd: uz.commander.signer)
  show [--state-dir D]                                     public key + fingerprint (maxfiy emas)
  generate                                                 kalit yo'q bo'lsa Keychain ichida yaratadi
  import --pem-stdin --expect-fingerprint FP [--replace]   mavjud Ed25519 PKCS8 PEM'ni stdin'dan Keychain'ga (fingerprint mos bo'lishi shart)
  import-rotations --stdin                                 center'ning rotations.json'ini (ochiq) stdin'dan
  export-backup --out FILE                                 shifrlangan DR zaxirasi (egasi: Touch ID/parol + passphrase, TTY kerak)
  verify-backup --in FILE                                  zaxirani passphrase bilan ochib tekshiradi (faqat fingerprint chiqadi)
  restore-backup --in FILE [--replace]                     zaxiradan tiklash (egasi tasdig'i + passphrase)
  delete-key --confirm-fingerprint FP                      Keychain'dan o'chirish (egasi tasdig'i)
  lock | unlock | status                                   qo'lda kill-switch (LOCK fayli)
  verify-log [--state-dir D]                               imzo logi xesh zanjirini tekshiradi
Muhit (faqat testlar): COMMANDER_SIGNER_TEST_KEYSTORE=/path/key.bin  Keychain o'rniga fayl.
"""

func fail(_ msg: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("commander-signer: \(msg)\n".utf8))
    exit(code)
}

var args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { print(usage); exit(2) }
args.removeFirst()

func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
func flag(_ name: String) -> Bool { args.contains(name) }

let stateDir = opt("--state-dir") ?? SignerPaths.defaultStateDir
let paths = SignerPaths(stateDir: stateDir)

func makeKeyStore() -> KeyStore {
    if let f = ProcessInfo.processInfo.environment["COMMANDER_SIGNER_TEST_KEYSTORE"], !f.isEmpty { return FileKeyStore(path: f) }
    return KeychainKeyStore()
}
let keyStore = makeKeyStore()
// Hech bir buyruq Keychain GUI so'rovini ko'rsatmaydi (binary qayta qurilganda osilib qolmasin): ACL mos kelmasa darhol xato (kod 9).
KeychainKeyStore.disableUserInteraction()

func readStdinAll() -> String { String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "" }

func promptPassphrase(_ prompt: String) -> String {
    var buf = [CChar](repeating: 0, count: 256)
    guard readpassphrase(prompt, &buf, buf.count, RPP_REQUIRE_TTY) != nil else { fail("an interactive terminal is required for the passphrase") }
    let s = String(cString: buf)
    for i in 0..<buf.count { buf[i] = 0 }
    return s
}

func requireOwner(_ reason: String) {
    guard isatty(STDIN_FILENO) == 1 else { fail("owner confirmation requires an interactive terminal") }
    guard LocalAuthOwnerAuth().confirm(reason: reason) else { fail("owner confirmation denied") }
}

func summary(_ seed: Data) -> String {
    let p = try? KeyImport.publicKey(seed: seed)
    return "fingerprint \(p?.fingerprint ?? "?")"
}

do {
    switch cmd {
    case "serve":
        try paths.prepare()
        KeychainKeyStore.disableUserInteraction()
        let audit = try AuditLog(path: paths.logPath)
        let service = SignerService(keyStore: keyStore, paths: paths, audit: audit)
        service.recoverRotationsIfNeeded()
        let secret = try AuthSecret.generate(at: paths.authSecret)
        let server = SignerServer(service: service, secret: secret)
        let port = UInt16(opt("--tcp-port") ?? "4320") ?? 4320
        if !flag("--no-tcp") { try server.listenTcp(port: port) }
        if let u = opt("--unix") { try server.listenUnix(path: u) }
        let fp = (try? service.info().fingerprint) ?? "no-key"
        try audit.append([("op", "boot"), ("result", "ok"), ("keyFp", fp), ("peer", "local"), ("tcpPort", flag("--no-tcp") ? "-" : String(server.boundTcpPort))])
        FileHandle.standardError.write(Data("commander-signer ready (key fingerprint \(fp), tcp 127.0.0.1:\(server.boundTcpPort), lock \(service.isLocked ? "ON" : "off"))\n".utf8))
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { server.stop(); exit(0) }
        src.resume()
        dispatchMain()
    case "show":
        guard let seed = try keyStore.loadSeed() else { fail("no signing key in the key store", code: 3) }
        let p = try KeyImport.publicKey(seed: seed)
        print("fingerprint \(p.fingerprint)")
        print("publicKey \(p.b64)")
    case "generate":
        if try keyStore.loadSeed() != nil { fail("a signing key already exists (use import --replace or rotate)", code: 4) }
        let k = Enc.randomBytes(32)
        try keyStore.storeSeed(k, replace: false)
        print(summary(k))
    case "import":
        guard flag("--pem-stdin"), let expected = opt("--expect-fingerprint") else { fail("import needs --pem-stdin and --expect-fingerprint") }
        let seed = try KeyImport.seed(fromPKCS8PEM: readStdinAll())
        let p = try KeyImport.publicKey(seed: seed)
        guard p.fingerprint == expected else { fail("fingerprint mismatch: input key is \(p.fingerprint), expected \(expected); nothing stored", code: 5) }
        if flag("--replace") { requireOwner("Replace the Commander command-signing key") }
        do { try keyStore.storeSeed(seed, replace: flag("--replace")) } catch KeyStoreError.exists {
            if let cur = try keyStore.loadSeed(), (try? KeyImport.publicKey(seed: cur).fingerprint) == expected { print("already imported: fingerprint \(expected) (unchanged)"); exit(0) }
            fail("a different signing key already exists; refusing (use --replace with owner confirmation)", code: 4)
        }
        guard let back = try keyStore.loadSeed(), (try? KeyImport.publicKey(seed: back).fingerprint) == expected else { fail("verification after store failed", code: 6) }
        print("imported: fingerprint \(expected) (verified in key store)")
    case "import-rotations":
        guard flag("--stdin") else { fail("import-rotations needs --stdin") }
        try paths.prepare()
        let data = Data(readStdinAll().utf8)
        guard let arr = try? JSONDecoder().decode([Rotation].self, from: data) else { fail("input is not a rotations JSON array") }
        try Rotations.write(arr, to: paths.rotationsPath)
        print("imported \(arr.count) rotation announcement(s)")
    case "export-backup":
        guard let out = opt("--out") else { fail("export-backup needs --out FILE") }
        guard !FileManager.default.fileExists(atPath: out) else { fail("\(out) already exists") }
        requireOwner("Export an encrypted backup of the Commander signing key")
        let p1 = promptPassphrase("Backup passphrase (min 12 chars): ")
        guard p1 == promptPassphrase("Repeat passphrase: ") else { fail("passphrases differ") }
        guard let seed = try keyStore.loadSeed() else { fail("no signing key in the key store", code: 3) }
        let rotations = Rotations.read(path: paths.rotationsPath, now: nowMs())
        let blob = try Backup.seal(seed: seed, rotations: rotations, passphrase: p1)
        guard FileManager.default.createFile(atPath: out, contents: blob, attributes: [.posixPermissions: 0o600]) else { fail("cannot write \(out)") }
        let reopened = try Backup.open(try Data(contentsOf: URL(fileURLWithPath: out)), passphrase: p1)
        print("backup written: \(out) (fingerprint \(reopened.fingerprint), re-opened and verified)")
    case "verify-backup":
        guard let inp = opt("--in") else { fail("verify-backup needs --in FILE") }
        let b = try Backup.open(try Data(contentsOf: URL(fileURLWithPath: inp)), passphrase: promptPassphrase("Backup passphrase: "))
        print("backup OK: fingerprint \(b.fingerprint), \(b.rotations.count) rotation announcement(s)")
    case "restore-backup":
        guard let inp = opt("--in") else { fail("restore-backup needs --in FILE") }
        requireOwner("Restore the Commander signing key from a backup")
        let b = try Backup.open(try Data(contentsOf: URL(fileURLWithPath: inp)), passphrase: promptPassphrase("Backup passphrase: "))
        try keyStore.storeSeed(b.seed, replace: flag("--replace"))
        try paths.prepare()
        if !b.rotations.isEmpty { try Rotations.write(b.rotations, to: paths.rotationsPath) }
        print("restored: fingerprint \(b.fingerprint)")
    case "delete-key":
        guard let fp = opt("--confirm-fingerprint") else { fail("delete-key needs --confirm-fingerprint FP") }
        guard let seed = try keyStore.loadSeed(), try KeyImport.publicKey(seed: seed).fingerprint == fp else { fail("fingerprint does not match the stored key", code: 5) }
        requireOwner("Delete the Commander command-signing key from the Keychain")
        try keyStore.deleteSeed()
        print("deleted key \(fp)")
    case "lock":
        try paths.prepare()
        FileManager.default.createFile(atPath: paths.lockPath, contents: Data("locked \(AuditLog.iso(nowMs()))\n".utf8), attributes: [.posixPermissions: 0o600])
        print("signer LOCKED (signing and rotation refused): \(paths.lockPath)")
    case "unlock":
        try? FileManager.default.removeItem(atPath: paths.lockPath)
        print("signer unlocked")
    case "status":
        print("lock \(FileManager.default.fileExists(atPath: paths.lockPath) ? "ON" : "off")")
        print("key \((try keyStore.loadSeed()) != nil ? "present" : "missing")")
    case "verify-log":
        let r = AuditLog.verify(path: paths.logPath)
        if let b = r.brokenAt { fail("audit log chain BROKEN at line \(b) (\(r.lines) lines read)", code: 7) }
        print("audit log chain OK (\(r.lines) lines)")
    default:
        print(usage); exit(2)
    }
} catch let e as KeyStoreError {
    if case .aclDenied = e { fail("\(e)", code: 9) }
    fail("\(e)")
} catch let e as SignerError {
    fail("\(e.code): \(e.message)")
} catch {
    fail("\(error)")
}
