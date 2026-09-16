import Foundation

struct RelayPendingEvent: Codable, Sendable {
    enum Kind: String, Codable, Sendable {
        case terminal
        case tool
    }

    let kind: Kind
    let sessionID: UUID
    let sequence: UInt64
    let occurredAt: Date
    let terminalData: Data?
    let toolPayload: RelayToolEvent?

    static func terminal(_ batch: TerminalOutputBatch) -> RelayPendingEvent {
        RelayPendingEvent(
            kind: .terminal,
            sessionID: batch.sessionID,
            sequence: batch.sequence,
            occurredAt: batch.capturedAt,
            terminalData: batch.bytes,
            toolPayload: nil
        )
    }

    static func tool(sequence: UInt64, event: ToolEvent) -> RelayPendingEvent {
        RelayPendingEvent(
            kind: .tool,
            sessionID: event.sessionID,
            sequence: sequence,
            occurredAt: event.occurredAt,
            terminalData: nil,
            toolPayload: RelayToolEvent(event)
        )
    }
}

struct RelayOutboxStore: Sendable {
    let directory: URL

    init(deviceID: UUID, directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            let root = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first ?? FileManager.default.temporaryDirectory
            self.directory = root
                .appendingPathComponent("TermRelay", isDirectory: true)
                .appendingPathComponent("RelayOutbox", isDirectory: true)
                .appendingPathComponent(deviceID.uuidString.lowercased(), isDirectory: true)
        }
    }

    func load() throws -> [RelayPendingEvent] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        .filter { $0.pathExtension == "json" }
        .compactMap { url in
            do { return try JSONDecoder().decode(RelayPendingEvent.self, from: Data(contentsOf: url)) }
            catch { return nil }
        }
        .sorted {
            $0.sessionID == $1.sessionID
                ? $0.sequence < $1.sequence
                : $0.sessionID.uuidString < $1.sessionID.uuidString
        }
    }

    func save(_ event: RelayPendingEvent) throws {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(event).write(to: fileURL(for: event), options: .atomic)
    }

    func remove(sessionID: UUID, through sequence: UInt64) throws {
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        let prefix = sessionID.uuidString.lowercased() + "-"
        for url in try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) where url.lastPathComponent.hasPrefix(prefix) {
            guard let storedSequence = Self.sequence(from: url.lastPathComponent),
                  storedSequence <= sequence else { continue }
            try FileManager.default.removeItem(at: url)
        }
    }

    private func fileURL(for event: RelayPendingEvent) -> URL {
        let sequence = String(format: "%020llu", event.sequence)
        return directory.appendingPathComponent(
            "\(event.sessionID.uuidString.lowercased())-\(sequence).json"
        )
    }

    private static func sequence(from filename: String) -> UInt64? {
        guard let separator = filename.lastIndex(of: "-") else { return nil }
        let start = filename.index(after: separator)
        return UInt64(filename[start...].dropLast(".json".count))
    }
}
