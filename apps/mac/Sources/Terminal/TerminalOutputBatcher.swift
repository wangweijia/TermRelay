import Foundation

struct TerminalOutputBatch: Sendable {
    let sessionID: UUID
    let sequence: UInt64
    let capturedAt: Date
    let bytes: Data
}

struct TerminalProbeSnapshot: Sendable, Equatable {
    var totalBytes: UInt64 = 0
    var batchCount: UInt64 = 0
    var lastSequence: UInt64 = 0
    var droppedBytes: UInt64 = 0
}

/// Stage-0 relay probe. It follows the future network path's batching contract
/// without requiring a Server: output is rendered immediately by SwiftTerm and
/// copied here for 40 ms / 8 KiB bounded batching.
final class TerminalOutputBatcher: @unchecked Sendable {
    typealias Handler = @Sendable (TerminalOutputBatch, TerminalProbeSnapshot) -> Void

    private let sessionID: UUID
    private let queue: DispatchQueue
    private let handler: Handler
    private let flushSize = 8 * 1_024
    private let maximumPendingBytes = 64 * 1_024
    private var pending = Data()
    private var snapshot = TerminalProbeSnapshot()
    private var timer: DispatchSourceTimer?

    init(sessionID: UUID, handler: @escaping Handler) {
        self.sessionID = sessionID
        self.handler = handler
        queue = DispatchQueue(label: "app.termrelay.output-batcher.\(sessionID.uuidString)")

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(40), repeating: .milliseconds(40))
        timer.setEventHandler { [weak self] in self?.flushPending() }
        timer.activate()
        self.timer = timer
    }

    func receive(_ data: Data) {
        guard !data.isEmpty else { return }
        queue.async { [weak self] in
            guard let self else { return }
            snapshot.totalBytes += UInt64(data.count)
            pending.append(data)

            if pending.count > maximumPendingBytes {
                let overflow = pending.count - maximumPendingBytes
                pending.removeFirst(overflow)
                snapshot.droppedBytes += UInt64(overflow)
            }
            if pending.count >= flushSize { flushPending() }
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            flushPending()
            timer?.cancel()
            timer = nil
        }
    }

    private func flushPending() {
        guard !pending.isEmpty else { return }
        snapshot.lastSequence += 1
        snapshot.batchCount += 1
        let batch = TerminalOutputBatch(
            sessionID: sessionID,
            sequence: snapshot.lastSequence,
            capturedAt: Date(),
            bytes: pending
        )
        pending.removeAll(keepingCapacity: true)
        handler(batch, snapshot)
    }
}
