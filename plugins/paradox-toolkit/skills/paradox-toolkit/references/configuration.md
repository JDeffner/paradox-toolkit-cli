# Configure pxtk

Install the prepared `@px-lsp/cli` package first. Confirm `pxtk --version` works. If it is not on PATH, invoke `node <package>/dist/pxtk.cjs` with the same arguments.

Store local settings in the mod's `.px-toolkit/pxtk.json`, or pass `--config <file>`. Keep machine-specific paths out of version control.

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

This example deliberately has no installed sources. Set the paths to the user's actual game data, generated script documentation, and validator. Omitting gamePath enables Steam discovery; explicit null disables it. Relative paths in the standard config resolve from the mod/project folder. Dependency order is base first.

Flags override environment variables, which override the config. `PX_GAME_ID` selects the profile. Per-game variables follow the existing toolkit convention: `PX_CK3_GAME_PATH`, `PX_CK3_LOGS_PATH`, `PX_CK3_MOD_PATH`, `PX_CK3_TIGER_PATH`, and `PX_CK3_USER_DATA_PATH`, with the selected game's uppercase identifier in place of CK3. Optional config userDataPath or CLI --user-data-path selects an existing launcher user-data folder for inspection. Launch requires that folder to match the canonical location from installed launcher metadata's gameDataPath; this setting does not redirect the engine's user directory.

For MCP, start `pxtk mcp --config <file>` from the mod folder, or set those environment variables in the client's local server configuration. MCP exposes 15 operations: status, search, inspect, read, impact, validate, new, init, create, loc, logs, format, image, playsets and launch as `pxtk_<operation>`. Tools declare input descriptions and output schemas. Preparation writers preview by default; inspect the proposed files, then set write to true and expect to the returned previewToken. New-mod creation requires that token. Launch instead requires start=true and expect from the same reviewed request. Both interfaces share the same result envelope and operate on saved files.

With the CLI on PATH, register it in the client from a configured mod folder. These commands follow the clients' installed `mcp add --help`; choose one:

```powershell
$configPath = (Resolve-Path .px-toolkit/pxtk.json).Path
codex mcp add paradox-toolkit -- pxtk mcp --config "$configPath"
# Or Claude Code, local to this project:
claude mcp add --transport stdio --scope local paradox-toolkit -- pxtk mcp --config "$configPath"
```

For a Claude plugin session, use `claude --plugin-dir <absolute-plugin-folder>` instead of a duplicate MCP registration. For Codex, place this portable skill in the project's `.agents/skills/paradox-toolkit` and register MCP separately. Check tool discovery and call pxtk_status in the actual client; registration syntax alone does not verify a working connection.

Tools capable of writes keep write annotations during previews. Noninteractive clients can require explicit permission for that individual tool before even a preview call. Successful status or read calls do not verify preparation access; use the client's tool permissions without changing the tool's annotations.

Call `pxtk_validate` with `{"writeBaseline":".px-toolkit/before-change.json"}` to create a baseline before edits, then with `{"baseline":".px-toolkit/before-change.json"}` to compare after edits. Both paths are relative to the configured mod unless absolute. Creation requires complete validation, an existing folder inside the mod, and a new JSON file. It never overwrites. writeBaseline is the explicit write authorization; validate does not accept a write boolean, and writeBaseline cannot be combined with baseline.

Validation reports game and validator versions, evidence and a compatibility reason. `unknown` means support has not been certified. Tiger's explicit unsupported-version warning produces `unsupported`, incomplete validation and retained findings, with no baseline creation or comparison. `complete` means checks finished without known incompatibility; it does not establish gameplay behavior.

For a new mod, `pxtk_new` accepts `{"output":".local/mods/research-mod","name":"Research Mod"}` using the server's selected game. The destination resolves from the process working directory, its parent must exist, and it must be absent or empty. The resolver keeps the selected or nearest project configuration but changes the editable mod to that destination. Inspect the preview's files, folders and nextSteps, then repeat these arguments with write=true and expect=data.previewToken. Descriptor/metadata and starter folders follow the game profile. Creation does not alter launcher registration or playsets; perform the returned follow-up separately.

Existing Tiger configuration in the toolkit config directory takes precedence over the mod-root Tiger configuration. An explicit tigerConfig takes precedence over both. That file controls Tiger's own dependency loading and suppressions; inspect it if its settings differ from the CLI's declared parents.

Portable project.json supplies the selected mod's authoring and diagnostic rules. Localization.json supplies author defaults, including language when not selected through CLI settings. Schema, playset, project and localization artifacts each read their legacy fallback independently. The CLI does not read VS Code's private machinePaths registry. Keep execution paths in CLI flags, environment variables or ignored pxtk.json.

The portable per-mod playset.json is an indexing overlay, separate from saved launcher playsets. Playsets and launch require the installed launcher-settings.json and existing user-data load settings. Listing or selecting saved playsets also requires the launcher database and saved playsets; launch without a playset does not. They do not register new mods or change the launcher's active database selection. Launch without an explicit playset preserves the engine load file. Registered .mod archives have path checks; metadata-format archives are unsupported. Windows launch has been tested; Linux process detection is untested and macOS startup is unsupported.

Create and loc set use the shared localization policy. Existing entries stay in their owned file; new keys use configured destinations, meaningful siblings, source files and established layouts. New vanilla overrides require a replace folder. Generated files require their source workflow. Changed defaults invalidate previews and validation baselines.
