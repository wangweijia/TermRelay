import AppKit
import Foundation
import SwiftTerm

final class CapturingTerminalView: LocalProcessTerminalView {
    var outputHandler: (@Sendable (Data) -> Void)?

    override func dataReceived(slice: ArraySlice<UInt8>) {
        super.dataReceived(slice: slice)
        outputHandler?(Data(slice))
    }
}

@MainActor
final class LocalTerminalSession: NSObject, ObservableObject {
    let id: UUID
    let directory: URL
    let tool: BuiltInTool
    let terminalView: CapturingTerminalView
    let startedAt: String

    @Published private(set) var state: SessionState = .starting {
        didSet { stateHandler?(id, state) }
    }
    @Published private(set) var title: String
    @Published private(set) var currentDirectory: String
    @Published private(set) var probeSnapshot = TerminalProbeSnapshot()

    private let launchConfiguration: LaunchConfiguration
    private let stateHandler: ((UUID, SessionState) -> Void)?
    private var outputBatcher: TerminalOutputBatcher!
    private var hasStarted = false

    init(
        directory: URL,
        tool: BuiltInTool,
        outputHandler relayOutputHandler: @escaping @Sendable (TerminalOutputBatch) -> Void = { _ in },
        stateHandler: ((UUID, SessionState) -> Void)? = nil
    ) throws {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw ToolLaunchError.invalidDirectory(directory.path)
        }

        id = UUID()
        self.directory = directory
        self.tool = tool
        self.stateHandler = stateHandler
        startedAt = RelayDate.now()
        launchConfiguration = try tool.adapter.makeLaunchConfiguration(directory: directory)
        title = "\(tool.displayName) — \(directory.lastPathComponent)"
        currentDirectory = directory.path

        var options = TerminalOptions.default
        options.termName = "xterm-256color"
        options.scrollback = 10_000
        terminalView = CapturingTerminalView(
            frame: .zero,
            font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
            options: options
        )
        super.init()

        terminalView.processDelegate = self
        terminalView.optionAsMetaKey = true
        terminalView.nativeForegroundColor = NSColor(
            calibratedRed: 0.88,
            green: 0.90,
            blue: 0.94,
            alpha: 1
        )
        terminalView.nativeBackgroundColor = NSColor(
            calibratedRed: 0.075,
            green: 0.085,
            blue: 0.105,
            alpha: 1
        )
        terminalView.caretColor = .systemGreen

        outputBatcher = TerminalOutputBatcher(sessionID: id) { [weak self] batch, snapshot in
            relayOutputHandler(batch)
            DispatchQueue.main.async { [weak self] in
                self?.probeSnapshot = snapshot
            }
        }
        terminalView.outputHandler = { [weak outputBatcher] data in
            outputBatcher?.receive(data)
        }
    }

    func startIfNeeded() {
        guard !hasStarted else { return }
        hasStarted = true
        let environment = launchConfiguration.environment
            .map { "\($0.key)=\($0.value)" }
            .sorted()
        terminalView.startProcess(
            executable: launchConfiguration.executableURL.path,
            args: launchConfiguration.arguments,
            environment: environment,
            execName: launchConfiguration.executableName,
            currentDirectory: launchConfiguration.directory.path
        )
        state = .running
    }

    func sendInterrupt() {
        let interrupt: [UInt8] = [0x03]
        terminalView.send(source: terminalView, data: interrupt[...])
    }

    func sendRemoteInput(_ data: Data) {
        guard state == .running else { return }
        let bytes = [UInt8](data)
        terminalView.send(source: terminalView, data: bytes[...])
    }

    func resize(columns: Int, rows: Int) {
        guard state == .running else { return }
        terminalView.resize(cols: columns, rows: rows)
    }

    func runVisualProbe() {
        guard tool == .shell, state == .running else { return }
        let command = "printf '\\033[1;32mTermRelay ANSI green\\033[0m  中文  Emoji: 🚀\\r\\n'; "
            + "printf '\\033[38;2;255;120;0mTrueColor probe\\033[0m\\r\\n'; "
            + "printf 'PTY size: '; stty size\r"
        let bytes = Array(command.utf8)
        terminalView.send(source: terminalView, data: bytes[...])
    }

    func terminate() {
        guard state == .running || state == .starting else { return }
        state = .stopping
        terminalView.terminate()
        outputBatcher.stop()
        state = .finished
    }
}

extension LocalTerminalSession: LocalProcessTerminalViewDelegate {
    nonisolated func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {
        // SwiftTerm updates the PTY winsize before notifying this delegate.
    }

    nonisolated func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
        Task { @MainActor [weak self] in
            guard !title.isEmpty else { return }
            self?.title = title
        }
    }

    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
        guard let directory else { return }
        Task { @MainActor [weak self] in self?.currentDirectory = directory }
    }

    nonisolated func processTerminated(source: TerminalView, exitCode: Int32?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            outputBatcher.stop()
            state = exitCode == 0 ? .finished : .failed
        }
    }
}
