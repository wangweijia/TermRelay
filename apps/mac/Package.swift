// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TermRelay",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "TermRelay", targets: ["TermRelay"]),
    ],
    targets: [
        .executableTarget(name: "TermRelay", path: "Sources"),
        .testTarget(name: "TermRelayTests", dependencies: ["TermRelay"], path: "Tests"),
    ]
)

