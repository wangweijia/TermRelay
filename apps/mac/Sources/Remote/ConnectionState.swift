import SwiftUI

enum ConnectionState: String, Sendable {
    case connected
    case connecting
    case offline
    case degraded

    var label: String { rawValue }

    var color: Color {
        switch self {
        case .connected: .green
        case .connecting: .orange
        case .offline: .gray
        case .degraded: .yellow
        }
    }
}

