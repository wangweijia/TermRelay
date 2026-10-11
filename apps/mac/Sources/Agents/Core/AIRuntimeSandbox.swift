import Foundation
import Darwin

/// OS-enforced facts-only policy. The writable provider state is separate from the workspace.
struct AIRuntimeSandbox: Sendable {
    let stateDirectory: URL
    func profile(executable: URL) throws -> String {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/sandbox-exec") else {
            throw AgentError.unsupportedCapability("factsOnly sandbox")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let path = String(decoding: try encoder.encode(canonical(stateDirectory)), as: UTF8.self)
        let binary = String(decoding: try encoder.encode(canonical(executable)), as: UTF8.self)
        return "(version 1)(allow default)(deny process-fork)(deny process-exec (require-not (literal \(binary))))(deny file-write* (require-not (subpath \(path))))"
    }

    private func canonical(_ url: URL) throws -> String {
        guard let resolved = url.path.withCString({ realpath($0,nil) }) else { throw AgentError.providerUnavailable("AI sandbox path unavailable") }
        defer { free(resolved) }
        return String(cString:resolved)
    }

    static func nativeCodex(_ configured: URL) -> URL? {
        let file = configured.resolvingSymlinksInPath()
        if file.pathExtension != "js" { return file }
        #if arch(arm64)
        let package = "codex-darwin-arm64"
        let target = "aarch64-apple-darwin"
        #else
        let package = "codex-darwin-x64"
        let target = "x86_64-apple-darwin"
        #endif
        let native = file.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("node_modules/@openai/\(package)/vendor/\(target)/bin/codex")
        return FileManager.default.isExecutableFile(atPath: native.path) ? native : nil
    }
}
