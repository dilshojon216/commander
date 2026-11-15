// swift-tools-version: 6.0
import PackageDescription

// Commander kontrakt modellari. Generated.swift libs/contracts'dan GENERATSIYA qilinadi
// (npm run -w libs/contracts gen:schema): qo'lda tahrirlanmaydi.
let package = Package(
    name: "CommanderContracts",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "CommanderContracts", targets: ["CommanderContracts"]),
    ],
    targets: [
        .target(name: "CommanderContracts"),
        .testTarget(name: "CommanderContractsTests", dependencies: ["CommanderContracts"]),
    ],
    swiftLanguageModes: [.v6]
)
