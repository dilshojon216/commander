// swift-tools-version: 6.0
import PackageDescription

// Commander menu-bar ilovasi (TASKS 4.2) va "Navbatchi" maskoti (4.6).
// MenuBarCore: sof mantiq (holat reduktori, formatlash, approval oqimi, qayta ulanish) — unit testlanadi.
// CommanderMenuBar: ilova (menu-bar ikonka + panel, Keychain, bildirishnomalar, WS). `.app` = scripts/build-app.sh.
// DashboardCore: native dashboard mantiqi (API, jonli kanallar, xavfsizlik, view model'lar); SwiftUI/AppKit import QILINMAYDI.
// DashboardUI: native dashboard ko'rinishlari (faqat SwiftUI, tarmoq yo'q). Chegarani scripts/check-layers.sh tekshiradi.
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
        .target(
            name: "DashboardCore",
            dependencies: [
                "MenuBarCore",
                .product(name: "CommanderContracts", package: "CommanderContracts"),
            ]
        ),
        .target(
            name: "DashboardUI",
            dependencies: ["DashboardCore", "MenuBarCore"]
        ),
        .executableTarget(
            name: "CommanderMenuBar",
            dependencies: [
                "MenuBarCore",
                "DashboardCore",
                "DashboardUI",
                .product(name: "CommanderContracts", package: "CommanderContracts"),
            ]
        ),
        .testTarget(
            name: "DashboardCoreTests",
            dependencies: [
                "DashboardCore",
                .product(name: "CommanderContracts", package: "CommanderContracts"),
            ],
            exclude: ["Fixtures"]
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
