import Foundation

struct LaunchConfiguration: Sendable {
    let executableURL: URL
    let arguments: [String]
    let directory: URL
    let environment: [String: String]
}

protocol CLIToolAdapter: Sendable {
    var toolID: String { get }
    var displayName: String { get }
    func makeLaunchConfiguration(directory: URL) throws -> LaunchConfiguration
}

