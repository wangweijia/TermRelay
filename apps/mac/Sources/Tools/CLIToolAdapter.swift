import Foundation

struct LaunchConfiguration: Sendable {
    let executableURL: URL
    let arguments: [String]
    let directory: URL
    let environment: [String: String]
    let executableName: String?
}

protocol CLIToolAdapter: Sendable {
    var toolID: String { get }
    var displayName: String { get }
    func detect() -> ToolAvailability
    func makeLaunchConfiguration(
        directory: URL,
        proxy: ToolProxyConfiguration
    ) throws -> LaunchConfiguration
}

struct ToolAvailability: Sendable, Equatable {
    let isAvailable: Bool
    let executablePath: String?
    let detail: String
}

enum BuiltInTool: String, CaseIterable, Identifiable, Sendable {
    case shell
    case codex

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .shell: "终端"
        case .codex: "Codex"
        }
    }

    func makeAdapter(executableURL: URL? = nil) -> any CLIToolAdapter {
        switch self {
        case .shell: LoginShellAdapter(configuredExecutableURL: executableURL)
        case .codex: CodexAdapter(configuredExecutableURL: executableURL)
        }
    }

    var adapter: any CLIToolAdapter { makeAdapter() }
}

struct LoginShellAdapter: CLIToolAdapter {
    let toolID = BuiltInTool.shell.rawValue
    let displayName = BuiltInTool.shell.displayName
    let configuredExecutableURL: URL?

    init(configuredExecutableURL: URL? = nil) {
        self.configuredExecutableURL = configuredExecutableURL
    }

    func detect() -> ToolAvailability {
        let path = shellURL.path
        return ToolAvailability(
            isAvailable: FileManager.default.isExecutableFile(atPath: path),
            executablePath: path,
            detail: path
        )
    }

    func makeLaunchConfiguration(
        directory: URL,
        proxy: ToolProxyConfiguration = .inherited
    ) throws -> LaunchConfiguration {
        let shell = shellURL
        guard FileManager.default.isExecutableFile(atPath: shell.path) else {
            throw ToolLaunchError.notExecutable(shell.path)
        }
        return LaunchConfiguration(
            executableURL: shell,
            arguments: [],
            directory: directory,
            environment: TerminalEnvironment.make(proxy: proxy, executableURL: shell),
            executableName: "-\(shell.lastPathComponent)"
        )
    }

    private var shellURL: URL {
        if let configuredExecutableURL { return configuredExecutableURL }
        let configured = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        return URL(fileURLWithPath: configured)
    }
}

struct CodexAdapter: CLIToolAdapter {
    let toolID = BuiltInTool.codex.rawValue
    let displayName = BuiltInTool.codex.displayName
    let configuredExecutableURL: URL?

    init(configuredExecutableURL: URL? = nil) {
        self.configuredExecutableURL = configuredExecutableURL
    }

    func detect() -> ToolAvailability {
        guard let url = configuredExecutableURL ?? ExecutableLocator.find(named: "codex") else {
            return ToolAvailability(
                isAvailable: false,
                executablePath: nil,
                detail: "未在 PATH、~/.local/bin、/opt/homebrew/bin 或 /usr/local/bin 找到 codex"
            )
        }
        guard FileManager.default.isExecutableFile(atPath: url.path) else {
            return ToolAvailability(
                isAvailable: false,
                executablePath: url.path,
                detail: "文件不存在或不可执行：\(url.path)"
            )
        }
        return ToolAvailability(isAvailable: true, executablePath: url.path, detail: url.path)
    }

    func makeLaunchConfiguration(
        directory: URL,
        proxy: ToolProxyConfiguration = .inherited
    ) throws -> LaunchConfiguration {
        guard let executable = configuredExecutableURL ?? ExecutableLocator.find(named: "codex") else {
            throw ToolLaunchError.notFound("codex")
        }
        return LaunchConfiguration(
            executableURL: executable,
            arguments: [],
            directory: directory,
            environment: TerminalEnvironment.make(proxy: proxy, executableURL: executable),
            executableName: nil
        )
    }

}

enum ToolLaunchError: LocalizedError, Equatable {
    case notFound(String)
    case notExecutable(String)
    case invalidDirectory(String)

    var errorDescription: String? {
        switch self {
        case .notFound(let name): "找不到可执行程序：\(name)"
        case .notExecutable(let path): "文件不可执行：\(path)"
        case .invalidDirectory(let path): "工作目录不可用：\(path)"
        }
    }
}

enum ExecutableLocator {
    static func find(named name: String) -> URL? {
        for directory in searchDirectories() {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    static func searchDirectories(preferredExecutableURL: URL? = nil) -> [String] {
        let environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let nvmRoot = URL(fileURLWithPath: home)
            .appendingPathComponent(".nvm/versions/node", isDirectory: true)
        let nvmPaths = (try? FileManager.default.contentsOfDirectory(
            at: nvmRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ))?
            .sorted {
                $0.lastPathComponent.compare(
                    $1.lastPathComponent,
                    options: .numeric
                ) == .orderedDescending
            }
            .map { $0.appendingPathComponent("bin", isDirectory: true).path } ?? []
        let preferredPaths = [
            preferredExecutableURL?.deletingLastPathComponent().path,
            environment["NVM_BIN"],
        ].compactMap { $0 }
        let environmentPaths = (environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)
        let fallbackPaths = [
            "\(home)/.volta/bin",
            "\(home)/.asdf/shims",
            "\(home)/.local/share/mise/shims",
            "\(home)/.bun/bin",
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        let paths = preferredPaths + environmentPaths + nvmPaths + fallbackPaths
        return paths.reduce(into: [String]()) { result, value in
            if !value.isEmpty, !result.contains(value) { result.append(value) }
        }
    }
}

enum TerminalEnvironment {
    static func make(
        proxy: ToolProxyConfiguration = .inherited,
        executableURL: URL? = nil
    ) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        environment["PATH"] = ExecutableLocator.searchDirectories(
            preferredExecutableURL: executableURL
        ).joined(separator: ":")
        environment["HOME"] = environment["HOME"] ?? home
        environment["SHELL"] = environment["SHELL"] ?? "/bin/zsh"
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        environment["TERM_PROGRAM"] = "TermRelay"
        environment["TERM_PROGRAM_VERSION"] = "0.1.0-m0"
        if environment["LANG"] == nil && environment["LC_ALL"] == nil {
            environment["LANG"] = "en_US.UTF-8"
        }
        return proxy.applying(to: environment)
    }
}
