// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TermRelay",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "TermRelay", targets: ["TermRelay"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/migueldeicaza/SwiftTerm.git",
            exact: "1.20.0"
        ),
    ],
    targets: [
        .executableTarget(
            name: "TermRelay",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            path: "Sources"
        ),
        .testTarget(name: "TermRelayTests", dependencies: ["TermRelay"], path: "Tests"),
    ]
)
