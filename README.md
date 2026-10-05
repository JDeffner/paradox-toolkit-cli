# pxtk

Standalone commands and local MCP tools for Paradox modding. Look up game documentation and mod definitions, inspect dependencies, and check saved mod files with the Toolkit language server and Tiger. VS Code is optional. This project has its own repository and package; it shares its game knowledge and core tools with the [Paradox Modding Toolkit](https://github.com/JDeffner/paradox-modding-toolkit).

The [project wiki](https://github.com/JDeffner/paradox-toolkit-cli/wiki) covers setup, commands, MCP clients, editing workflows and known limits.

## Install

Download `px-lsp-cli-0.1.0.tgz` from the [GitHub releases](https://github.com/JDeffner/paradox-toolkit-cli/releases) and install it with `pnpm add -g ./px-lsp-cli-0.1.0.tgz`. Then run `pxtk --version` and `pxtk --help`. Node 22.22.2 or newer is required. This initial release is distributed on GitHub; it is not published to npm.

For a source build:

Requires Node 22.22.2 or newer and pnpm. From this repository:

```sh
git clone https://github.com/JDeffner/paradox-toolkit-cli.git
cd paradox-toolkit-cli
pnpm install --frozen-lockfile
pnpm run compile
pnpm pxtk --help
pnpm pack --pack-destination .local/artifacts
```

Install the resulting tarball with `pnpm add -g <tarball>` to get the `pxtk` command. The package contains its own compiled LSP, per-game data, and licenses. It does not install the game or Tiger, and it makes no model API calls. The commands above build locally and do not publish anything.

## Configure a mod

For an existing mod, run `pxtk init --game ck3 --mod <existing-mod> --json` to preview its configuration. Apply the same request with `--write --expect <previewToken>` after reviewing it. For a new mod, use the [new-mod workflow](#create-a-new-mod). `init` preserves existing configuration.

You can also create `.px-toolkit/pxtk.json` in the mod/project folder:

```json
{
  "game": "ck3",
  "gamePath": null,
  "logsPath": null,
  "tigerPath": null,
  "parents": [],
  "language": "english"
}
```

Set the paths to your game data, generated script documentation and Tiger executable. A game installation root is accepted and normalized to its game folder. Omit gamePath for Steam discovery; null disables discovery. The selected game must be explicit. Profiles currently include ck3, vic3 and eu5; capabilities follow each profile, including whether Tiger is supported.

The nearest `.px-toolkit/pxtk.json` is found by walking upward from the current directory. Relative paths in that file use its project folder. An explicitly selected config outside `.px-toolkit` uses the config's own folder. The mod defaults to that folder. Keep local paths in an ignored config.

Flags override environment variables, which override the config. Supported variables are `PX_GAME_ID` and `PX_<GAME>_GAME_PATH`, `_LOGS_PATH`, `_MOD_PATH`, `_TIGER_PATH`, `_TIGER_CONFIG`, and `_USER_DATA_PATH`. Repeat `--parent <folder>` in dependency load order, base first. Explicit configuration errors are reported; they do not trigger discovery of another installation.

The CLI also reads portable `.px-toolkit/project.json`, `localization.json`, `schema.json` and `playset.json`. Each artifact falls back independently to the game's legacy config folder. Invalid project rules are reported. Structural and Tiger validation use the mod's diagnostic suppression rules; Tiger also respects inline suppressions. Editor machinePaths settings are private to VS Code and are not read by the CLI.

Localization defaults supply the language when neither a flag nor pxtk.json selects one. Create and loc set share the editor's placement rules: existing entries stay in place, configured destinations win for new keys, and meaningful siblings and established layouts guide automatic placement. A mod prefix alone does not select a file. New vanilla overrides require a replace folder. Generated localization files require their source workflow.

## Commands

```sh
pxtk status --json
pxtk search add_gold --json
pxtk inspect add_gold --kind effect --json
pxtk read events/mymod_events.txt --start-line 1 --line-count 100 --json
pxtk impact my_effect --kind scripted_effect --json
pxtk validate --json
pxtk validate --write-baseline .px-toolkit/before-change.json --json
pxtk validate --baseline .px-toolkit/before-change.json --json
```

Use `--limit` (1 to 200, default 20) to bound returned matches or findings. Totals and truncation flags describe each list. `--timeout` bounds each server request and Tiger process. Run `pxtk --help` for all flags.

Status reports actual loaded sources and missing capabilities. Search returns identifiers and definitions. Inspect accepts an exact name and asks for a kind when meanings conflict. Impact describes callers from the editable mod and outgoing dependencies; read-only callers are outside its coverage. Its override list inherits the LSP catalog's 2000-entry cap.

Validation checks the selected mod's supported saved files and runs Tiger against the selected game. It reports structural diagnostics, Tiger findings, and tool failures separately. Baselines preserve occurrence counts while ignoring line movement, so moving code does not make an existing error new. Create a baseline as a JSON file in an existing directory inside the editable mod. An existing file is never replaced. Comparison rejects a different game version, validator, schema, documentation, dependency content, or configuration. A clean static report does not establish in-game behavior.

Validation's `complete` means structural checks and Tiger completed without a known compatibility rejection. `compatibility.status: "unknown"` means support for this game version is not certified. An explicit Tiger warning about a newer unsupported game sets `compatibility.status: "unsupported"`, `complete: false`, and exit 2. Findings remain visible, but baseline creation and comparison are refused. Missing or failed Tiger also makes validation incomplete. Relative baseline paths resolve from the configured mod, including when the command runs elsewhere.

Exit codes: **0** completed without new errors; **1** new errors, no match, or ambiguity; **2** invalid configuration, unavailable validation, cancellation, or execution failure. Warnings remain in the report and do not set exit 1.

## MCP and skills

Start the local stdio MCP server with:

```sh
pxtk mcp --config <config-file>
```

Only MCP messages go to stdout. Research tools include `pxtk_status`, `pxtk_search`, `pxtk_inspect`, `pxtk_read`, `pxtk_impact`, `pxtk_conflicts` and `pxtk_playsets`. Preparation adds `pxtk_rename`, `pxtk_edit`, `pxtk_import` and `pxtk_package` alongside the existing writers. `pxtk_loc` includes translation synchronization. `pxtk_migrate` lists migrations, queries routes and previews recipes. `pxtk_validate` can create a baseline; `pxtk_launch` can start the game. These 21 tools declare input descriptions and output schemas. Indexed operations start a fresh LSP session and reuse its disk cache. Requests are serialized.

With `pxtk` on PATH, run one of these registrations from the configured mod folder. The syntax follows the installed clients' `mcp add --help`:

```powershell
$configPath = (Resolve-Path .px-toolkit/pxtk.json).Path
# Codex CLI:
codex mcp add paradox-toolkit -- pxtk mcp --config "$configPath"
# Or Claude Code, local to this project:
claude mcp add --transport stdio --scope local paradox-toolkit -- pxtk mcp --config "$configPath"
```

[plugins/paradox-toolkit](plugins/paradox-toolkit) contains Codex and Claude plugin manifests, the stdio connection configuration, and a portable Agent Skill. Install the CLI on PATH before loading the plugin. Clients supporting plain Agent Skills can load its `skills/paradox-toolkit` directory directly. This toolkit skill complements the separate Paradox AI Modding scripting, GUI and playtest skills.

For a local Claude plugin session, run `claude --plugin-dir <absolute-path-to-plugins/paradox-toolkit>` from the mod folder. That plugin includes its own MCP registration, so use it instead of the separate registration above. For Codex, copy the portable `skills/paradox-toolkit` directory to your project's `.agents/skills/paradox-toolkit` alongside the MCP registration. These setup instructions do not certify client behavior; verify tool discovery and a `pxtk_status` call in your client.

Write-capable tools retain write annotations even when called in preview mode. A noninteractive Codex session with approval disabled can reject such a preview unless that individual tool has explicit approval. Grant permission for the needed tool through the client's controls; a successful read call does not verify writer access.

MCP baseline creation is an explicit write request. Call `pxtk_validate` with these arguments before edits, then compare after edits:

```json
{ "writeBaseline": ".px-toolkit/before-change.json" }
```

```json
{ "baseline": ".px-toolkit/before-change.json" }
```

Do not add `write: true` to these validation calls. `writeBaseline` authorizes creation directly; it is mutually exclusive with `baseline` and never replaces an existing file.

## Boundaries

Commands read saved files. They cannot see an editor's unsaved buffers. Read queries reject concurrent input changes. Utility writers check their source snapshots before applying edits. Game installations and dependency mods are reference inputs. Normal operations also maintain an LSP cache and temporary validator configuration.

## Prepare mod content

Preparation writers show a preview until you add `--write`. Inspect its files and use its `previewToken` with `--expect` when applying the same options. Application recomputes the proposal from current saved files. Files are staged before writing. New files use exclusive creation; updates replace one file atomically. A batch is not a filesystem transaction: a write failure reports which files completed. Save editor buffers before applying disk edits.

For example, from a configured mod folder in PowerShell:

```powershell
$createArgs = @("create", "event", "mymod.1", "--prefix", "mymod", "--json")
$preview = pxtk @createArgs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Preview failed." }
$preview.data.files | Format-List file, action, content, contentTruncated
# Review the proposed files, then apply the same request and returned token.
pxtk @createArgs --write --expect $preview.data.previewToken
```

The equivalent calls to `pxtk_create` use these arguments. Replace `<previewToken>` with `data.previewToken` from the first response after inspecting `data.files`:

```json
{ "kind": "event", "name": "mymod.1", "prefix": "mymod" }
```

```json
{ "kind": "event", "name": "mymod.1", "prefix": "mymod", "write": true, "expect": "<previewToken>" }
```

```sh
pxtk init --game ck3 --mod <existing-mod> --json
pxtk create
pxtk create event mymod.1 --prefix mymod --json
pxtk loc get mymod_1_t --json
pxtk loc set mymod_1_t --value "A new title" --json
pxtk loc check --language german --json
pxtk format events/mymod_events.txt --check
pxtk format events/mymod_events.txt --json
```

Init creates .px-toolkit/pxtk.json for an existing mod and never replaces configuration. It saves the game, relative mod root and language; supply installation paths through environment variables or local configuration. Create lists supported kinds from the selected profile. CK3 and Victoria 3 expose their existing scaffold templates; EU5 currently exposes scripted effects and triggers, under its selected stage root. No unverified event template is supplied for EU5. Use --stage only for a stage listed by that game profile.

Create appends to compatible files and rejects duplicate mod definitions, localization keys and mismatched headers. Generated script and localization files have a UTF-8 BOM. Localization set preserves existing comments, versions, line endings and sibling entries. It updates an existing mod entry, places vanilla overrides in localization/replace, and puts new keys with their siblings. Use --file to resolve multiple mod destinations. Check reports the selected language's indexed missing keys and untranslated values; dynamic references can remain unknown. Formatting changes only leading indentation in script and GUI files. It does not format localization.

## Create a new mod

`new` prepares a mod in an absent or empty destination. Its parent folder must exist. Metadata paths and starter folders come from the selected game profile. This PowerShell example keeps the scratch mod under `.local/`:

```powershell
New-Item -ItemType Directory -Force .local/mods | Out-Null
$newArgs = @("new", ".local/mods/research-mod", "--name", "Research Mod", "--game", "ck3", "--json")
$preview = pxtk @newArgs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Preview failed." }
$preview.data | ConvertTo-Json -Depth 8
# Review metadata, folders and nextSteps before applying.
pxtk @newArgs --write --expect $preview.data.previewToken
```

The destination is relative to the CLI or MCP process working directory. The resolver reuses the explicit or nearest project configuration but changes the editable mod to the destination. `pxtk_new` accepts `output`, `name`, optional `supportedVersion`, and the same `write`/`expect` preview flow. Configure the MCP server's game before calling it. New-mod creation requires a preview token to apply, rejects links and nonempty destinations, and creates the descriptor or metadata, `.px-toolkit/pxtk.json`, and profile-derived folders. It does not register the mod in a launcher or change launcher playsets. Follow the returned `nextSteps`, which depend on the profile's descriptor format. An unknown installed version defaults to `*`; review the declared version before distribution.

For `pxtk_new`, preview with the first argument object below. After inspecting that response, replace `<previewToken>` in the second object with its `data.previewToken`:

```json
{ "output": ".local/mods/research-mod", "name": "Research Mod" }
```

```json
{
  "output": ".local/mods/research-mod",
  "name": "Research Mod",
  "write": true,
  "expect": "<previewToken>"
}
```

## Prepare images

```sh
pxtk image inspect art/icon.png --json
pxtk image convert art/icon.png --to dds --dds auto --output gfx/interface/icon.dds --json
pxtk image convert art --to dds --output gfx/interface/prepared --json
pxtk image convert art/icon.png --to png --width 128 --height 128 --fit contain --output prepared/icon.png --json
pxtk image convert art/icon.png --to jpeg --background "#ffffff" --output prepared/icon.jpg --json
```

Inputs can be DDS, TGA, PNG, JPEG or WebP. Outputs can be DDS, PNG, JPEG or WebP. Folder batches preserve subfolders, report unsupported files and reject output collisions. Destinations must be new files inside the editable mod. Source files remain unchanged.

Resize modes are contain (default, transparent padding), cover (crop to fill), inside (keep the image within the bounds), and fill (stretch). JPEG requires a background when pixels are transparent. DDS auto selects BC3 for transparency and BC1 otherwise; BGRA8 is also available. BC1 rejects transparent pixels. DDS output has one mip level, and existing mipmaps are not copied. Assets that require a complete mip chain need a converter that generates that chain before use in the game. Cubemaps, texture arrays, volumes and animated inputs are unsupported. The operation applies EXIF orientation and does not copy image metadata. Inspection reports dimensions, format, alpha channel and mip count.

The CLI uses Sharp for headless common-format decoding, encoding and resizing. Package installation supplies its native runtime; optional platform dependencies must be enabled. The toolkit's DDS and TGA codecs remain shared with the editor. There is no VS Code or external image-editor requirement. Limits are 200 images, 16 megapixels per image, 64 MiB per input file, and 256 MiB of compressed inputs per batch.

## Maintain existing content

These workflows are available in the source build. Each new writer requires both `--write` and the `--expect` token from the same reviewed request. Omitting them returns a preview.

Synchronize a translation with its source language:

```sh
pxtk loc sync --source-language english --language german --json
pxtk loc sync --source-language english --language german --file localization/english/mymod_l_english.yml --json
```

Sync adds missing keys as blank entries with source-language comments. It preserves existing translations, including keys already translated in another file, and follows the source file's language and stage layout. It does not translate text. Duplicate keys, malformed headers and generated localization files are refused.

Rename a definition or localization key from its declaration or an indexed reference:

```sh
pxtk rename --file common/scripted_effects/mymod.txt --line 1 --column 1 --to mymod_renamed_effect --json
pxtk edit --file common/traits/mymod.txt --operations edits.json --json
```

Rename positions are 1-based UTF-16 coordinates. The shared language server refuses collisions, foreign definitions and unsupported symbol kinds. Every proposed destination must be in the editable mod. Dynamic references can be missed, so inspect the returned coverage and validate after applying. Edited script and localization files use UTF-8 with BOM; unrelated text and line endings remain unchanged.

For `edit`, `edits.json` contains an array of shared definition operations. Values are script source; `null` removes a property. `upsertBlock` accepts a definition name and its full block text. A refused operation rejects the batch.

```json
[{ "op": "setProperties", "name": "mymod_trait", "properties": [{ "key": "martial", "value": "2" }] }]
```

The MCP equivalents accept `{file,line,column,to}` for `pxtk_rename` and `{file,edits:[...]}` for `pxtk_edit`. Apply with `write: true` and `expect: data.previewToken`. Indexed mod and dependency changes invalidate these previews. Vanilla is identified by installation and version; concurrent manual vanilla edits require a fresh preview.

## Inspect conflicts and import vanilla

```sh
pxtk conflicts --json
pxtk conflicts --input <base-mod> --input <later-mod> --limit 50 --json
pxtk import --source common/scripted_effects/<file>.txt --json
pxtk import --directory common/scripted_effects --json
```

Conflict inputs run from first loaded to last loaded. With no explicit inputs, the command uses configured parents followed by the editable mod. Explicit inputs need only a selected game, not an editable workspace. The report includes contributors, proven winners, replacement paths, dependency issues and a source fingerprint. Unknown precedence stays unknown. Vanilla is excluded, binary files need external review, and profiles without a verified composition policy return incomplete. Exit 1 means the report contains conflicts or composition issues, including identical overlaps that still need review.

Import copies one exact game-relative file into the matching mod path. Directory import creates the selected path and missing parents without copying its contents. Existing destinations, traversal and links are refused. Source bytes are preserved; game files remain read-only.

## Stage a mod release

```sh
pxtk package --output <new-release-folder> --json
```

Review included and excluded files, hashes, total size and descriptor findings. Apply with the preview token to create a new output folder outside the mod, game and dependency folders. Its parent must already exist. The command uses Toolkit `.pxignore` semantics: an existing file replaces the default patterns, Toolkit configuration is always excluded, and descriptor metadata is always kept. It never creates or changes `.pxignore`. Descriptor errors block staging; warnings remain visible. Source changes invalidate the token. Failed import and package writes report completed files, partial files and created folders. Inspect those paths before retrying; partial files are retained to preserve concurrent edits.

Staging creates a directory, not an archive, and does not upload to Steam. Its metadata checks do not certify Workshop acceptance or gameplay compatibility.

## Review migrations

```sh
pxtk migrate catalog --game ck3 --json
pxtk migrate routes --game ck3 --from <exact-build> --to <exact-build> --json
pxtk migrate preview --recipe <catalog-id> --source-game-path <old-game-data> --target-game-path <new-game-data> --answers answers.json --json
```

Catalog and route queries do not require an editable mod. Preview uses the selected mod and the recipe's declared source/target evidence. Required installation builds must be identifiable and match the recipe. Answers are a JSON object of question IDs with string or boolean values. The result reports applicability, unanswered questions, blockers and a proposed plan with hashes and bounded file previews. No migration plan is applied; apply and restore are separate workflows.

For a local recipe, first use `--recipe-file <artifact.cjs>` without `--trust`. This returns its SHA-256 and preview without loading its code. After reviewing the artifact, repeat with `--trust <sha256>`; changed code is refused. Executable artifacts use CommonJS. Bundle their dependencies because the artifact hash does not cover imported files. Local recipes run with the process's filesystem and network permissions. Workers provide cancellation and crash isolation, not a sandbox. The MCP migration tool therefore declares write and external-access capability even though the adapter does not apply plans. Recipe stdout and stderr are captured inside bounded diagnostics, preserving JSON output.

## Launch a playset

List saved launcher playsets, ordered mods and profile presets without an editable mod:

```sh
pxtk playsets --game ck3 --json
pxtk launch --game ck3 --playset "<exact-ID-or-unique-name>" --arg=-debug_mode --json
```

Launch previews the executable, working folder, literal arguments and engine load settings. Review them, then repeat the same request with `--start --expect <previewToken>`. Launch uses `--start`, not `--write`. Extra arguments can also follow `--`; put CLI options before it. `--preset <id>` accepts only a preset returned by playsets. The installed `launcher-settings.json` supplies the executable and base arguments; the working folder is the executable's folder, and the game profile supplies SteamAppId.

For `pxtk_launch`, preview with the first object, then use its `data.previewToken` in the second after review:

```json
{ "playset": "<exact-ID-or-unique-name>", "args": ["-debug_mode"] }
```

```json
{
  "playset": "<exact-ID-or-unique-name>",
  "args": ["-debug_mode"],
  "start": true,
  "expect": "<previewToken>"
}
```

Installed launcher metadata and an existing engine load file are required. Listing or selecting saved playsets also requires the launcher database and saved playsets. Without `--playset`, launch preserves the current engine load file, which can differ from the launcher's active database playset. An explicit playset loads enabled mods in saved order and applies disabled DLC. It preserves unrelated load settings and enabledUGC, backs up a changed load file before writing, and restores it after a startup failure only if no later edit would be overwritten. The launcher database and active selection remain unchanged. Registered `.mod` archives have path checks; metadata-format archives are unsupported. The mod's `.px-toolkit/playset.json` remains a separate indexing overlay.

Use `--user-data-path`, config `userDataPath`, or `PX_<GAME>_USER_DATA_PATH` to inspect another user-data folder. Launch requires that folder to match the canonical location from launcher metadata's gameDataPath. Engine user-directory redirection is unsupported. A stale token or an already-running game rejects startup before changing load settings.

Windows launch has process-fixture coverage. Linux launch fixtures run in an isolated process namespace; a normal desktop can refuse launch with `process_probe_failed` if any same-user process is unreadable. This preserves duplicate-game protection. Real Linux game startup has not been tested; macOS startup is unsupported. The returned process state is a one-second observation. An initial exit with code 0 reports `exited`; `running` does not prove the mod loaded or gameplay works. Once started, the game remains open when the CLI or MCP caller disconnects.

## Read playtest errors

```powershell
$checkpointArgs = @("logs", "checkpoint", "--output", ".px-toolkit/before-playtest.json", "--json")
$preview = pxtk @checkpointArgs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Preview failed." }
$preview.data.files | Format-List file, content
pxtk @checkpointArgs --write --expect $preview.data.previewToken
# Reproduce the behavior in the game.
pxtk logs --since .px-toolkit/before-playtest.json --json
```

Logs reads error.log from the profile's runtime log folder, which can differ from script_docs. Use --file to select a saved log. Checkpoints record file identity, a complete-line byte offset and a prefix hash. Rotation, truncation or rewriting resets the read and is reported. Incomplete final lines wait until a later read. Records spanning the checkpoint retain preceding context. Duplicate messages are grouped with occurrence counts and source locations; unparsed records remain visible. Checkpoint output files are created exclusively. The command reads at most 32 MiB and does not launch or control the game.

## Focus queries and validation

```sh
pxtk inspect <identifier> --kind <kind> --examples --templates --json
pxtk impact <identifier> --kind <kind> --json
pxtk validate events/mymod_events.txt --json
```

Inspect's optional lists contain sourced examples and templates measured from documentation, harvested skeletons or indexed definitions. Empty template lists mean no supported template was found. Impact reports exact standard-LSP reference sites separately from callers grouped by definition, plus override candidates, ordering rules and the winner. Dynamic reference forms can be missed.

Supplying files to validate focuses structural checks. Tiger still checks the whole mod, and all its findings remain visible. The scope field states both scopes, and baseline compatibility includes the selected file set. This is not a full structural workspace pass.

Formatting, scaffolding, logs, initialization, new-mod creation, source reading and image preparation do not start the LSP. Localization and indexed queries use a fresh session and reuse its cache.

Inspect excerpts preserve `file`, `line`, `contextStart`, and `context`, with limits of 18 lines and 500 characters per line. `truncated`, `omittedBefore`, `omittedAfter`, and `clippedLines` identify missing text. Pass an excerpt's `continuation` object to `pxtk_read` to start reading the whole file. For CLI paging:

```powershell
$page = pxtk read events/mymod_events.txt --line-count 100 --max-chars 16000 --json | ConvertFrom-Json
$page.data.text
if ($page.data.next) {
  pxtk read $page.data.file --start-line $page.data.next.startLine --start-column $page.data.next.startColumn --source-hash $page.data.sourceHash --json
}
```

Follow `next.startLine` and `next.startColumn` with the returned `sourceHash` until `next` is null. Concatenate `text` for lossless decoded content; `context` is display text. Positions are one-based UTF-16 columns, including CR characters in CRLF endings. Reading preserves line endings and strips a UTF-8 BOM; encoding is reported. The default page has at most 100 source lines and 16,000 characters, with maxima of 200 and 64,000. Files are limited to 16 MiB and supported text types under the canonical mod, dependency, or game-data roots. Binary files and links escaping these roots are rejected. A saved edit rejects hashed continuation with `source_changed`; restart the read.

Source labels identify generated dumps, bundled snapshots, or wiki data. They do not certify a documentation/game patch match. The toolkit's per-mod `playset.json` adds parents after the configured list, matching the LSP. Saved launcher playsets are used only by playsets and launch; they do not select indexed dependencies. An existing Tiger configuration controls Tiger dependency loading and suppressions; it takes precedence over generated dependency blocks.

The CLI, MCP and JSON result contract is documented in [PROTOCOL.md](docs/PROTOCOL.md). Developer checks live in `test/`; the real CK3 exercise is `scripts/test-pxtk-real.ts`.

The [release audit](docs/AUDIT-2026-10-05.html) records tested behavior, fixed defects, remaining limits and possible CLI additions from the editor Toolkit. The first release has automated CLI and MCP coverage; it does not certify gameplay or every game and platform combination.

## Development

```sh
pnpm run compile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm pack --pack-destination .local/artifacts
pnpm test:package .local/artifacts/px-lsp-cli-0.1.0.tgz
```

The package test installs the archive in an isolated folder and runs research, writing, image inspection and failure checks. For real CK3 validation, copy `dev-paths.example.json` to ignored `dev-paths.json`, configure the game-data folder and Tiger executable, and run `pnpm test:real`. The equivalent environment variables are `PX_CK3_GAME_PATH`, `PX_CK3_LOGS_PATH` and `PX_CK3_TIGER_PATH`. Game files remain read-only; generated mods and reports stay under `.local/`.

## Shared Toolkit packages

The required server and protocol changes are not yet published on npm. This repository pins their package archives in `vendor/toolkit-core/` so a fresh checkout can build without a second repository or machine-specific links. The [manifest](vendor/toolkit-core/manifest.json) records the source revision, versions and SHA-256 checksums. Both archives include their matching `src/` trees and licenses. The recorded upstream commit can be local until the Toolkit publishes it; the source archives here remain available with this release. These are upstream dependency snapshots, not a separate implementation of the game rules.

To refresh them from a Toolkit checkout with committed shared-core changes and installed build dependencies:

```sh
pnpm core:import <toolkit-checkout>
pnpm install
```

Then run the development checks above and review the archive manifest and lockfile changes. Maintain fixes in the Toolkit source. When matching core versions are published, registry dependencies can replace the archives. CLI releases bundle the core, game data and licenses; users do not need either source checkout.
