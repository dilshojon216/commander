// swift-tools-version: 6.0
import PackageDescription

// Commander menu-bar ilovasi (TASKS 4.2) va "Navbatchi" maskoti (4.6).
// MenuBarCore: sof mantiq (holat reduktori, formatlash, approval oqimi, qayta ulanish) — unit testlanadi.
// CommanderMenuBar: SwiftUI ilova (MenuBarExtra, Keychain, bildirishnomalar, WS). `.app` = scripts/build-app.sh.
// API modellari FAQAT clients/swift/CommanderContracts dan (qo'lda yozilmaydi).
let package = Package(
    name: "CommanderMenuBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CommanderMenuBar", targets: ["CommanderMenuBar"]),
    ],
    dependencies: [
        .package(path: "../../clients/swift/CommanderContracts"),
    ],
    targets: [
        .target(
            name: "MenuBarCore",
            dependencies: [.product(name: "CommanderContracts", package: "CommanderContracts")]
        ),
        .executableTarget(
            name: "CommanderMenuBar",
            dependencies: [
                "MenuBarCore",
                .product(name: "CommanderContracts", package: "CommanderContracts"),
            ]
        ),
        .testTarget(
            name: "MenuBarCoreTests",
            dependencies: [
                "MenuBarCore",
                .product(name: "CommanderContracts", package: "CommanderContracts"),
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)
