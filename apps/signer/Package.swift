// swift-tools-version: 6.0
import PackageDescription

// Commander imzolovchi (TASKS 5.7, H-02): buyruq-imzo kaliti macOS Keychain'da, markaz (Docker) faqat imzo so'raydi.
// SignerCore: sof mantiq + Keychain + server (unit testlanadi). commander-signer: CLI/daemon (launchd: uz.commander.signer).
// Swift tanlandi: Keychain'da "faqat shu binary" ACL (SecAccess + SecTrustedApplication) Node'dan mumkin emas; qarang docs/adr.
let package = Package(
    name: "CommanderSigner",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "commander-signer", targets: ["commander-signer"]),
    ],
    targets: [
        .target(name: "SignerCore"),
        .executableTarget(name: "commander-signer", dependencies: ["SignerCore"]),
        .testTarget(name: "SignerCoreTests", dependencies: ["SignerCore"]),
    ],
    swiftLanguageModes: [.v5]
)
