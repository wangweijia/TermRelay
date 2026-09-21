# TermRelay Agent Guide

## Start Here

- Use Node.js 22+ and the pnpm version declared in `package.json`; install dependencies with `pnpm install`.
- Read [README.md](README.md) for setup and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing cross-component behavior.
- Run the narrowest relevant check while iterating, then run `pnpm check` before finishing changes that cross package boundaries.

## Repository Boundaries

- `packages/contracts/**/*.schema.json` is the source of truth for the Mac, server, and web protocol. Do not hand-edit files under `packages/contracts/generated/`.
- Keep PTY and ACP paths distinct. PTY carries terminal bytes and resize/input operations; ACP carries structured turns, tool calls, approvals, and user questions.
- The Mac owns local paths and subprocesses. The web talks only to the server, and the server stores opaque workspace IDs rather than local paths.
- The server validates and persists protocol data; do not move Codex or DSH protocol parsing into the server or web.
- TypeORM schema changes require explicit migrations. Keep `synchronize: false` and never use production credentials for local development.
- Do not commit secrets or log credentials. DSH keys stay in macOS Keychain; database, Bark, and Cloudflare credentials belong in ignored environment files.

## Area Conventions

- `apps/mac` is a Swift Package Manager app, not an Xcode project. Mac builds require a full Xcode toolchain with `metal`; Command Line Tools alone are insufficient. Preserve actor isolation: UI state belongs on `@MainActor`, while remote and structured-agent runtimes use actors and `Sendable` boundaries.
- Mac process changes must preserve ownership-based cleanup, PTY fallback when structured startup fails, ordered session/event IDs, and bounded output buffering.
- `apps/server` is NestJS with Fastify, native WebSockets, TypeORM, CommonJS output, and Node's built-in test runner. Tests are colocated as `*.spec.ts`.
- `apps/web` is Vue 3 with Pinia and Vite. Its production output is served by the server; do not design it as an independently deployed service.
- Keep changes compatible with the strict TypeScript base configuration and existing package-local module settings.

## Verification

- Contracts: `pnpm contracts:check`
- Server: `pnpm --filter @termrelay/server test`
- Web: `pnpm --filter @termrelay/web build`
- Mac: `pnpm mac:test` (includes the required SwiftPM cache paths and `--disable-sandbox`)
- All TypeScript packages: `pnpm -r --if-present typecheck`
- Full repository gate: `pnpm check`

Real Codex and DSH probes are opt-in and may require local CLIs or credentials. Use the commands documented in [README.md](README.md) only when the change touches those integrations; ordinary tests must not start real agents or send model requests.

## Canonical References

- Environment setup, ports, and database separation: [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md)
- Codex App Server decision and PTY fallback: [docs/ADR-001-CODEX-APP-SERVER.md](docs/ADR-001-CODEX-APP-SERVER.md)
- Structured agent adapter lifecycle: [docs/STRUCTURED_AGENT_ADAPTER_DESIGN.md](docs/STRUCTURED_AGENT_ADAPTER_DESIGN.md)
- Production security boundary: [docs/CLOUDFLARE_ACCESS.md](docs/CLOUDFLARE_ACCESS.md)
- Offline server release and migration flow: [docs/SERVER_RELEASE.md](docs/SERVER_RELEASE.md)