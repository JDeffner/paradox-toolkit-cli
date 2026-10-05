# pxtk JSON and MCP contract

The base types live in `@px-lsp/protocol/agentTools`. The standalone CLI owns additive operations and fields in `src/contract.ts`, request definitions in `src/requests.ts`, and MCP output schemas in `src/responses.ts`. Shared language-service types and game knowledge remain upstream. The [Toolkit protocol reference](https://github.com/JDeffner/paradox-modding-toolkit/blob/main/docs/PROTOCOL.md) documents the underlying LSP methods.

## Additional workflows

The CLI and MCP expose 21 operations. The additions below preserve the base envelope. New writers (`rename`, `edit`, `import`, `package`, and `loc` with `action: "sync"`) require `expect` when `write` is true. Unknown fields are rejected. CLI JSON argument files are UTF-8 and limited to 4 MiB.

| Operation | Request fields                                                                                                                                             | Result data                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| conflicts | Optional `inputs` (1 to 200 ordered mod paths), `limit`                                                                                                    | `supported`, `game`, `inputOrder`, ordered `inputs`, `sourceFingerprint`, counts, bounded `conflicts` and `issues`, `coverage`.                           |
| rename    | `file`, `line`, `column`, `to`; optional `write`, `expect`                                                                                                 | Standard write result plus `from`, `to`, exact per-file `edits`, and `coverage`.                                                                          |
| edit      | `file`, `edits`; optional `write`, `expect`                                                                                                                | Standard write result plus per-file `edits`, per-operation `ops`, and `coverage`.                                                                         |
| import    | Exactly one `source` file or `directory` path; optional `write`, `expect`                                                                                  | Standard write result plus `source`, `destination`, `kind`, and `folders`. Directory import has an empty `files` array.                                   |
| package   | `output`; optional `limit`, `write`, `expect`                                                                                                              | `mode`, `previewToken`, `destination`, `changed`, `written`, `ready`, totals, and bounded `included`, `excluded`, `findings`.                             |
| migrate   | `action`: catalog/routes/preview; optional `recipe`, `recipeFile`, `trust`, `fromBuild`, `toBuild`, `sourceGamePath`, `targetGamePath`, `answers`, `limit` | Read/preview result with trust state, bounded catalog/routes, installation evidence, inspection, blockers and optional prepared plan. No apply operation. |
| loc sync  | `action: "sync"`, `sourceLanguage`, target `language`; optional source `file`, `write`, `expect`                                                           | Standard write result plus `sourceLanguage`, `targetLanguage`, `addedKeys`, and source/target `mappings`.                                                 |

Conflict inputs are first loaded first; omitted inputs use configured parents then the editable mod. Vanilla is not included. Explicit inputs require only game configuration. The shared profile must define a composition policy; unsupported profiles return `incomplete`. Each conflict includes `id`, `name`, `kind`, `state`, `fingerprint`, `explanation`, nullable `winner`, bounded `contributors` and `issues`. No winner is inferred for unverified precedence. Binary inventory is not a content hash. Exit 1 reports conflicts or composition issues, including identical overlaps. The core capture API requires a disjoint existing host boundary, so source roots overlapping the Node executable directory are refused.

Rename `line` and `column` are 1-based UTF-16 coordinates. Exact returned edit offsets are 0-based UTF-16 into the original BOM-free decoded text: `{file, edits:[{start,end,newText}]}`. Any outside-mod edit, provider refusal, collision, invalid range or stale indexed input rejects the operation. Dynamic reference coverage remains limited. The identity includes mod/dependency content and configuration; vanilla is identified by installation and version. Script/localization outputs use UTF-8 with BOM while retaining unrelated text and line endings.

Definition `edits` uses the shared `DefinitionOp` union: `{op:"setProperties",name,properties:[{key,value}]}` or `{op:"upsertBlock",name,text}`. Values are raw script strings; `null` deletes a property. CLI `--operations <file>` loads the array. MCP accepts it directly as `edits`. A refused operation or invalid resulting script rejects the entire batch.

Translation sync requires different explicit source and target languages. It mirrors source-language paths, respects profile stage roots, adds blank entries with source comments, and preserves existing translated values anywhere in the target-language mod. It rejects ambiguous keys, malformed localization and generated source/destination files. Source and target inventories bind the preview token. This operation does not translate text.

Import `source` and `directory` are game-relative paths without traversal. File import preserves exact saved bytes. Directory import creates only the selected path and parents. Existing destinations and linked paths are refused. Package `output` resolves from the process working directory and must be absent, outside every source root, with an existing parent. Staging honors `.pxignore` defaults or its complete custom replacement, mandatory Toolkit exclusions and retained descriptor metadata. Included entries carry `{file,bytes,sha256}`; exclusions carry `{file,reason}`; findings carry `{level,file,message}`. Descriptor errors yield `ready:false`, an incomplete preview, and block writes. Staging never uploads or certifies Workshop/gameplay acceptance. Write failures report partial outputs.

Migration catalog/routes require only game configuration. Routes require exact `fromBuild` and `toBuild`. Preview requires an editable mod and a selected entry; required reference installations must have detected matching builds. CLI `--from` and `--to` map to build fields, `--recipe-file` maps to `recipeFile`, and `--answers <file>` loads a string/boolean answer object. Local artifact paths resolve from the configured mod. Without `trust`, only the artifact bytes/hash are read and `trustRequired:true` returns incomplete. `trust` must match the artifact SHA-256 before any code is loaded.

Migration results use `action`, `mode:"read"|"preview"`, `trustRequired`, `prepared`, `gameplayTested:false`, and bounded worker `diagnostics`. Preview adds `manifest`, `recipeCodeHash`, `references`, inspection/questions/answer results, `snapshotHash`, `blockedReasons`, and a `plan` when prepared. Plan files are paged; before/after values carry hashes, byte counts, UTF-8 or base64 content, and `contentTruncated` after 16,000 characters. A prepared plan is a proposal and does not establish gameplay compatibility. Local trusted code has host permissions, including filesystem/network access; the worker is not a sandbox. The MCP migration tool therefore declares `readOnlyHint:false`, `destructiveHint:true` and `openWorldHint:true`. The adapter never applies plans, captures worker output instead of writing it to stdout, and terminates workers on completion, cancellation or timeout.

## pxtk CLI and MCP

The `pxtk` command and local MCP implementation are maintained in the separate `paradox-toolkit-cli` project. CLI and MCP use the same additive contract and `schemaVersion: 1` envelope.

MCP input objects are strict. Unknown fields, including misspelled write or preview-token arguments, are rejected before execution. Use the input schema returned by tool discovery for exact field names.

Preparation operations extend the core queries with new, init, create, loc, logs, format and image. All are available through the CLI and matching `pxtk_*` MCP tools. CLI `--to` maps to the image request's `format` field. Common preparation write arguments are `write` (default false) and `expect` (a preview token).

Launcher operations are playsets and launch, alongside the content and research operations. Playsets takes no request fields and reads saved launcher playsets without an editable mod. Launch accepts optional `playset` (exact ID or unique name), `preset` (profile preset ID), `args` (array of literal arguments), `start` (default false), and `expect`. CLI equivalents are `--playset`, `--preset`, repeated `--arg=<argument>` or arguments after `--`, and `--start --expect <token>`. Configuration selects the game, installation and optional `userDataPath`; CLI `--user-data-path` or `PX_<GAME>_USER_DATA_PATH` can override that folder.

Playsets data is `{ settingsFile, userDataPath, databasePath, loadSettingsFile, presets, playsets }`. Presets contain `{ id, label, args }`. Each playset contains `{ id, name, active, loadOrder, mods, disabledDlcs }`. Mods retain saved order and contain `{ id, name, enabled, position, path, registryId, status, archivePath }`; path, registryId and archivePath can be null. Position can be a number or string.

Launch data contains `mode: "preview" | "started"`, `previewToken`, `executable`, `cwd`, `args`, `steamAppId`, nullable `playset`, `loadSettings`, nullable `backupFile`, nullable `process`, `launcherSelectionChanged: false`, and `gameplayTested: false`. Load settings contain `{ file, format: "dlc" | "content", changed, beforeSha256, afterSha256, data }`. Process contains `{ pid, state: "running" | "exited", exitCode }`; exitCode is null while running. The executable and base arguments come from installed launcher-settings.json. Arguments run without a shell, cwd is the executable's folder, and SteamAppId comes from the game profile.

Inspect a preview, then repeat the same request with `start: true` and `expect: <data.previewToken>`. Launch does not accept `write`. For MCP, call `pxtk_launch` with `{"playset":"<exact-ID-or-unique-name>","args":["-debug_mode"]}`, then with the same fields plus `"start":true,"expect":"<previewToken>"`. A missing token returns `preview_required`; changed inputs or options return `stale_preview`. An already-running executable returns `game_already_running` before any load-file change.

Installed launcher metadata and existing engine load settings are required. Listing or selecting saved playsets also requires the launcher database and saved playsets. Omitting playset preserves the current engine load file, rather than selecting the launcher's active database playset. Explicit selection applies enabled mods in order and disabled DLC, preserves unrelated fields and enabledUGC, and backs up a changed load file. Startup failure restores that file only if no subsequent edit would be replaced. The database and its active selection are never written. Registered `.mod` archives have path checks; metadata-format archives are unsupported. Launcher selection does not change indexed parents or the separate per-mod playset.json overlay.

Alternate userDataPath folders can be inspected, but launch requires a canonical match to launcher metadata's gameDataPath. Engine user-directory redirection is unsupported. Windows launch has process-fixture coverage. Linux launch fixtures run in an isolated process namespace; an unreadable same-user process on a normal host causes process_probe_failed so duplicate-game protection remains intact. Real Linux game startup has not been tested; macOS startup is unsupported. Process state records only the first second after startup. An initial exit code 0 reports exited; neither state proves loading or gameplay. Caller cancellation after startup does not terminate the game.

| Operation | Input                                                                                                                    | Data                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| new       | output, name; optional supportedVersion, write, expect                                                                   | New mod descriptor/metadata, profile-derived folders and toolkit configuration; no launcher registration.        |
| init      | Optional write, expect                                                                                                   | Exclusive configuration creation for an existing mod.                                                            |
| create    | Optional kind, name, prefix, stage, language, write, expect                                                              | No kind lists profile-supported templates. A selected kind previews or writes script and localization files.     |
| loc       | action: get/set/check/sync; optional name, value, file, stage, language, limit, write, expect                            | Lookup sources, bounded language coverage or a localization edit proposal. Set and sync can write.               |
| logs      | action: read/checkpoint; optional file, since, output, limit, write, expect                                              | Grouped records, rotation status, pending bytes and checkpoint metadata. Only checkpoint creates an output file. |
| format    | files array; optional check, write, expect                                                                               | Conservative indentation edits and changed count.                                                                |
| image     | action: inspect/convert; files array; optional output, format, dds, width, height, fit, background, limit, write, expect | Image metadata or conversion results. Only convert writes.                                                       |
| playsets  | No request fields                                                                                                        | Saved launcher playsets with ordered mods, disabled DLC and profile presets.                                     |
| launch    | Optional playset, preset, args, start, expect                                                                            | Reviewed executable, arguments and engine load settings; startup observation after explicit start.               |

Utility write results contain mode (preview/check/written), previewToken, changed, written and files. Each file has its mod-relative path, create/update action, before/after SHA-256 and output byte count. Text previews include at most 16,000 characters with contentTruncated. Passing expect binds application to the recomputed preview and rejects changed inputs or options. Writers check source snapshots immediately before applying changes. New files are exclusive creations; each update is atomic, but a batch is not transactional. A failure reports completed paths. Destinations cannot escape the editable mod or traverse linked paths. Image, configuration and checkpoint outputs never replace existing files.

Apply a preparation preview by keeping its options and adding `write: true` and `expect: <data.previewToken>`. Inspect `data.files` first. New-mod creation requires that token, an absent or empty destination, and an existing parent directory. Its `output` resolves from the process working directory; other preparation destinations are mod-relative. New-mod data also returns `destination`, `name`, `descriptor`, `supportedVersion`, `folders`, `launcherRegistered: false`, and profile-derived `nextSteps`. No launcher registration or playset change is made. An omitted supportedVersion uses the detected game's wildcard version when available, otherwise `*`.

Inspect accepts examples and templates booleans for separate bounded lists. Impact returns exact standard-LSP reference sites (file, line, column, 1-based) separately from callers grouped by definition. Its coverage labels dynamic-reference limits and override ordering/winners. Validate accepts an optional files array to focus structural checks. Tiger still checks the whole mod and all Tiger findings remain visible. The scope field reports structural (selected_files/workspace), tiger (workspace) and selected paths. Baseline identity includes the sorted structural selection.

Formatting check differences and localization coverage findings use exit 1. Preparation commands that do not load the LSP report unknown documentation provenance and an empty serverVersion. Localization entries report their own indexed source locations. Formatting, scaffolding, initialization, logs and image preparation use shared modules directly.

The standalone `@px-lsp/cli` package exposes research, source reading, validation, and preparation commands. Its indexed operations use existing Toolkit LSP methods without changing their names or payloads.

`--json` prints one object to stdout. Help (including no command) uses `{ schemaVersion: 1, version, help }`; `--version --json` uses `{ schemaVersion: 1, version }`. Operation results use this envelope:

```ts
interface PxtkResult<Data = Record<string, unknown>> {
  schemaVersion: 1;
  operation:
    | "status"
    | "search"
    | "inspect"
    | "read"
    | "impact"
    | "conflicts"
    | "rename"
    | "edit"
    | "import"
    | "package"
    | "migrate"
    | "validate"
    | "playsets"
    | "launch"
    | "init"
    | "new"
    | "create"
    | "loc"
    | "logs"
    | "format"
    | "image";
  status: "ok" | "not_found" | "ambiguous" | "incomplete";
  sources: {
    game: string;
    gamePath: string | null;
    gameVersion: string;
    mod: string;
    parents: string[];
    logsPath: string | null;
    documentation: "generated" | "bundled" | "wiki" | "none" | "unknown";
    documentationMatchesGame: "unknown";
    serverVersion: string;
    savedFilesOnly: true;
  };
  warnings: string[];
  data: Data;
}
```

Execution and input errors use `{ schemaVersion: 1, status: "error", error: { code, message } }`. The game must be explicitly selected. The documentation field describes loaded script identifiers; the status command's index data separately reports data-type provenance. Documentation provenance is separate from patch compatibility: neither a bundled snapshot nor a generated dump certifies the latter.

| Operation | Input                                                                              | Data                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| status    | No query                                                                           | Resolved config file, index status, capabilities, issues, Tiger configuration, and setup steps. Invalid paths return issues without starting the LSP.  |
| search    | `query`, optional `kind`                                                           | Documentation and LSP workspace-symbol matches, plus documentation sources.                                                                            |
| inspect   | `name`, optional `kind`                                                            | Exact documentation entries and definition source excerpts. An ambiguous name returns candidates and asks for a kind.                                  |
| read      | `file`; optional `startLine`, `startColumn`, `lineCount`, `maxChars`, `sourceHash` | Bounded saved source text with explicit omissions, positions, hash and continuation.                                                                   |
| impact    | `name`, optional `kind`                                                            | Definition, callers, outgoing dependencies, overrides, and coverage limits. Multiple definition kinds return an ambiguity result.                      |
| validate  | Optional `files`, `baseline` or `writeBaseline`, `limit`                           | Structural and Tiger results, compatibility, full counts, bounded findings, baseline comparison/creation, input identity, and `gameplayTested: false`. |

`limit` is optional (default 20, range 1 to 200). Lists use `{ items, total, truncated }`; totals count all matches available to the adapter before its own limit. Workspace-symbol lookup inherits the LSP cap of 512 matches, and impact inherits the override catalog cap of 2000 entries. Search's standard LSP locations retain zero-based positions; source excerpts, impact sites, and findings use one-based lines. Documentation entries retain their existing LSP shapes.

Inspect source excerpts preserve `file`, `line`, `contextStart`, and `context`. They add `totalLines`, `sourceHash`, `encoding`, `limits: { lineCount: 18, charsPerLine: 500 }`, `truncated`, `omittedBefore`, `omittedAfter`, `clippedLines: [{ line, startColumn: 501, totalChars }]`, and `next`. `next` points to the first clipped line's remaining text, or the line after the excerpt. `continuation: { file, startLine: 1, startColumn: 1, sourceHash }` is a complete `pxtk_read` argument object for starting the entire file.

Read accepts `startLine` and `startColumn` (one-based, default 1), `lineCount` (default 100, range 1 to 200), and `maxChars` (default 16,000, range 1 to 64,000). Data contains `{ file, startLine, startColumn, endLine, endColumn, text, context, totalLines, sourceHash, encoding, truncated, omittedBefore, omittedAfter, next }`. End positions are exclusive. `next` is `{ startLine, startColumn }` or null. Pass both continuation coordinates, the same file and returned sourceHash to the next read. Concatenate `text`, which preserves decoded line endings and strips a UTF-8 BOM; `context` is display-only. Columns and character budgets count UTF-16 units, including CR before LF. A final newline counts a final empty line. `truncated` is true if either a prefix or suffix is omitted, including the final page of a continued read; use `next === null` to detect the end.

The hash covers saved source bytes, including a BOM. A mismatch returns `source_changed`; restart reading. Source reads use canonical paths under the configured mod, parents, or game-data folder, with a 16 MiB file limit. Allowed text extensions are `.txt`, `.gui`, `.asset`, `.mod`, `.yml`, `.yaml`, `.json`, `.info`, `.lua`, `.gfx`, `.sfx`, `.shader`, `.csv`, and `.md`. Unsupported extensions, binary controls, and links escaping these roots are rejected. Encoding follows the shared parser: `utf8`, `utf8-bom`, or `latin1-fallback`.

Validation reports `complete`, `baselineApplied`, `structural`, `tiger`, `compatibility`, `context`, `findings`, `newFindings`, `existingFindings`, `resolvedFindings`, and `newErrors`. A finding has `source` (structural or tiger), `code`, `severity` (error, warning, or info), `message`, and nullable `file`, `line`, `column`. Files are relative to the editable mod where possible. A missing Tiger integration, process error or unreadable report makes the result incomplete, even if structural checks passed. Baseline comparison is applied only after complete validation.

Top-level compatibility and `tiger.compatibility` contain `{ status: "unknown" | "unsupported", gameVersion, validatorVersion, evidence, reason }`. Nullable versions and evidence preserve missing facts. `unknown` means compatibility has not been certified, even after a completed process. `unsupported` requires Tiger's explicit warning that the installed game is newer than its supported version. That warning leaves `tiger.status: "complete"` when the process completed, but sets overall `complete: false` and `status: "incomplete"`. Returned findings remain available; no baseline is created or applied. Thus `complete` establishes completed checks without known incompatibility, not certified version support or gameplay success.

CLI exit codes are 0 for completed work without new errors, 1 for new errors/no match/ambiguity, and 2 for invalid input, incomplete coverage, cancellation, or execution failure. `status: "ok"` on validation means the tools completed; inspect `newErrors` to determine whether it passed. Warnings do not set exit 1.

CLI `validate --write-baseline <file>` maps to MCP `pxtk_validate`'s `writeBaseline` argument. It explicitly authorizes exclusive creation, without a `write` boolean or preview token. `baseline` and `writeBaseline` are mutually exclusive. Both paths resolve relative to the configured mod, or can be absolute. Creation requires complete validation and a new JSON file in an existing directory inside the editable mod. It never overwrites a file and returns `baselineWritten` on success. Incomplete validation returns its findings and a warning that the baseline was not created.

Before edits, call `pxtk_validate` with `{"writeBaseline":".px-toolkit/before-change.json"}`. After edits, call it with `{"baseline":".px-toolkit/before-change.json"}`. The baseline stores `schemaVersion: 1`, `type: "pxtk-baseline"`, validation `context`, and all findings. Comparison counts repeated findings while ignoring line and column movement. It rejects changed game/version, validator/configuration, schema, documentation, language, structural file selection, or dependency content. Game files are identified by installation and detected version; manual changes to vanilla without a version change require a fresh validation target.

`pxtk mcp` serves every operation over local stdio as `pxtk_<operation>`. Each tool declares described input fields and an output schema, then returns the envelope in both JSON text content and `structuredContent`. Execution errors and incomplete results set `isError`. Invalid MCP arguments are rejected earlier with the SDK's standard tool-error response. New validation findings remain normal tool results so an agent can inspect them. Query tools, including pxtk_playsets, declare readOnlyHint true. Preparation tools and validate declare write capability, because explicit write mode or writeBaseline can create files. pxtk_launch declares readOnlyHint false and openWorldHint true, including in preview mode. Only protocol messages go to stdout; process diagnostics go to stderr. Each call resolves the configuration again. Indexed operations use a fresh LSP session; source reads, launcher operations and direct preparation utilities do not start one. Requests are serialized; cancellation and closed stdin stop tool-owned child processes, but leave an already-started game open.
