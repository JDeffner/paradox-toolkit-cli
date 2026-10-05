# Paradox Toolkit CLI

`pxtk` is a standalone CLI and local stdio MCP server for Paradox mod research and preparation. This repository owns the command interface, adapters, tests, and plugin files. The Paradox Modding Toolkit owns the shared parser, game profiles, localization policy, Tiger helpers, and texture codecs.

## Boundaries

- Keep game knowledge in the upstream game profiles. Never add rules from memory or edit the pinned package archives by hand.
- `vendor/toolkit-core/manifest.json` records the upstream revision and archive checksums. Refresh through `pnpm core:import <toolkit-checkout>`, then install and run the checks below. Published core packages can replace these snapshots when they contain the required APIs.
- Preserve the base JSON contract from `@px-lsp/protocol/agentTools`. Standalone additions live in `src/contract.ts`, with MCP output schemas in `src/responses.ts` and the public contract in `docs/PROTOCOL.md`. Keep stdout machine-readable when using JSON or MCP.
- Writers preview by default, require explicit write mode, reject stale inputs, and preserve unrelated content. Vanilla and dependency mods are read-only. Script and localization outputs require the game-compatible BOM and headers.
- Game and tool paths belong in environment variables or ignored `dev-paths.json`. Keep scratch mods and test artifacts under `.local/`.
- Public documentation uses neutral project language and contains no personal machine paths.
- Work on a feature branch. Commit, push, publish, or create a remote repository only when requested. Preserve other work.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm run compile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm pack --pack-destination .local/artifacts
pnpm test:package .local/artifacts/px-lsp-cli-0.1.0.tgz
```

The packaged test must run the installed command without a Toolkit checkout. Writer or validation changes also use `pnpm test:real` with configured CK3 and Tiger paths. Report missing corpus settings and game/validator version mismatches. A static check does not establish gameplay behavior.
