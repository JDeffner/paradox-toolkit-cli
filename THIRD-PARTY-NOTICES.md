# Third-party notices

The Paradox Toolkit CLI is licensed under GPL-3.0-or-later. Its original source was extracted from the [Paradox Modding Toolkit](https://github.com/JDeffner/paradox-modding-toolkit). The shared server and protocol remain maintained there. The pinned dependency revision and package hashes are recorded in `vendor/toolkit-core/manifest.json`.

The [CLI source repository](https://github.com/JDeffner/paradox-toolkit-cli) includes the build scripts and pinned core archives. Each archive includes its matching source under `package/src/`, including core changes whose upstream commit is not yet public. Use the source tag matching the CLI release to obtain these inputs.

## Bundled components

| Component                                                                          | Use                                                               | License          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------- |
| [Paradox Modding Toolkit](https://github.com/JDeffner/paradox-modding-toolkit)     | Language server, game profiles, shared helpers and texture codecs | GPL-3.0-or-later |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)       | Local stdio MCP interface                                         | MIT              |
| [Zod](https://github.com/colinhacks/zod)                                           | Configuration and tool argument validation                        | MIT              |
| [VS Code Language Server](https://github.com/microsoft/vscode-languageserver-node) | LSP and JSON-RPC transport and types                              | MIT              |

The build collects the license text for every bundled package, including transitive dependencies, in `dist/licenses/`. `dist/licenses/dependencies.json` records their versions and declared licenses. Toolkit source attribution is also included in `dist/lsp/THIRD-PARTY-NOTICES.md`. Game-data attribution travels with the corresponding folders under `dist/data/`.

## Installed image codec

[Sharp](https://github.com/lovell/sharp) handles common image formats and resizing. It is installed as a native runtime dependency under Apache-2.0. Its libvips dependency is LGPL-2.1-or-later. The native packages include their own notices.

## External validator

[Tiger](https://github.com/amtep/tiger) is an external validator. It is not bundled or installed by this package. Configure a separately installed executable to use deep validation.
