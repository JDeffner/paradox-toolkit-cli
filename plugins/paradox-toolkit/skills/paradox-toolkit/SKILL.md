---
name: paradox-toolkit
description: Research Paradox mod changes, read source pages, create mods, prepare scripts, localization and images, validate saved files, and launch saved playsets with pxtk.
---

# Paradox Toolkit

Use the local `pxtk` commands or equivalent `pxtk_*` MCP tools to ground mod work in the selected game and mod. The toolkit works without VS Code. Use either the CLI or MCP available in the client; do not repeat an operation through both. Toolkit writers preview changes and apply them only in explicit write mode.

## Choose the workspace

Read the project's instructions and use its configured game, mod, dependencies, and validation target. Run `pxtk status --json` when the workspace is new or configuration has changed. If setup is missing, use `pxtk --help` and [configuration.md](references/configuration.md). Never guess a game identifier or silently validate against a different installation.

Status distinguishes loaded documentation from files merely present on disk. A generated dump is not proof that it matches the installed patch. Validation compatibility is `unknown` unless Tiger explicitly reports an unsupported newer game version. `unknown` does not certify support. Missing, failed or known-unsupported Tiger makes validation incomplete; preserve findings and that limitation in the result.

## Find evidence for a change

- Search with a narrow term: `pxtk search "<term>" --json`.
- Inspect a matching identifier: `pxtk inspect <name> --kind <kind> --json`.
- Use `pxtk impact <name> --kind <kind> --json` before changing a definition used elsewhere.
- Inspect excerpts show omissions and clipped lines, with limits of 18 lines and 500 characters per line. Use the excerpt's `continuation` as `pxtk_read` arguments to read the whole source. With the CLI, use `pxtk read <file> --json`, then pass both `--start-line` and `--start-column` from `data.next` plus `--source-hash` from the response until next is null. Concatenate `data.text`, not display context. Unknown identifiers and ambiguous names require more evidence.
- Scope information is guidance. It does not establish that a construct is invalid.

Keep game identifiers, accepted fields, and example code tied to the returned sources. Use the project's scripting, GUI, or playtesting instructions for domain-specific work.

Read pages default to 100 lines and 16,000 characters; maxima are 200 and 64,000. Coordinates are one-based UTF-16 units. Text preserves decoded line endings and strips a UTF-8 BOM; sourceHash covers saved bytes. A changed hash rejects continuation with `source_changed`. Restart reading after a saved edit. Source files must be supported text under the configured mod, dependencies, or game data, at most 16 MiB; links cannot extend those roots.

## Edit and check

Use pxtk create to list profile-supported scaffolds, loc get/set/check for localization, format for indentation and image inspect/convert for texture preparation. Use --help for arguments. Writers preview by default. Apply authorized changes with --write and the returned token in --expect; if the token is stale, review a fresh preview. Save relevant editor buffers first. Follow the project's localization placement rules; vanilla overrides require localization/replace, while configured destinations and existing layouts determine where new keys go. Image outputs must be new files; JPEG transparency needs an explicit background, and DDS output has no generated mipmaps.

For a new mod, use `pxtk new <folder> --name "Display Name" --game <id> --json`, or `pxtk_new` with output and name in a server configured for that game. Its parent folder must exist, and the destination must be absent or empty. Inspect the descriptor/metadata, profile-derived folders, and nextSteps; apply with write and the returned preview token. Creation requires the token. Launcher registration remains a separate step described by nextSteps; the tool does not change launcher state. An unknown installed version uses `*`, which must be reviewed before distribution.

This PowerShell example previews and inspects a scaffold before applying it from a configured mod:

```powershell
$createArgs = @("create", "event", "mymod.1", "--prefix", "mymod", "--json")
$preview = pxtk @createArgs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Preview failed." }
$preview.data.files | Format-List file, action, content, contentTruncated
# Review the proposed files, then apply the same options and returned token.
pxtk @createArgs --write --expect $preview.data.previewToken
```

For MCP, call `pxtk_create` with `{"kind":"event","name":"mymod.1","prefix":"mymod"}`. Inspect the returned files, then send the same arguments with `"write":true` and `"expect":"<previewToken>"`, replacing the placeholder with `data.previewToken` from that response. See [configuration.md](references/configuration.md) for client setup.

For playtests, preview a fresh checkpoint with `pxtk logs checkpoint --output .px-toolkit/before-test.json --json`, inspect its file, and repeat with `--write --expect <previewToken>` using the returned token. Then read `pxtk logs --since .px-toolkit/before-test.json`. Report rotation and unparsed entries. Reading logs does not establish that the intended gameplay behavior occurred.

List saved launcher playsets and profile presets with `pxtk playsets --game <id> --json` or `pxtk_playsets`. Preview `pxtk launch --game <id> --playset "<exact-ID-or-unique-name>" --arg=-debug_mode --json`. Inspect the executable, arguments, playset and load settings; start an authorized launch by repeating the same options with `--start --expect <previewToken>`. MCP pxtk_launch takes `playset`, optional `preset` and an `args` array; repeat with start=true and expect=data.previewToken. Launch uses start, not write. Pass each argument literally, never as a shell command. Use only presets returned by playsets.

Omitting playset preserves current engine load settings, which can differ from the launcher's active database playset. Explicit selection updates only the engine load file, with a backup and stale-preview checks; the database selection and indexed parents remain unchanged. Close an already-running game before starting another playset. Installed launcher metadata and an existing engine load file are required; listing or selecting saved playsets also requires the launcher database and saved playsets. An alternate userDataPath can be inspected, but launch requires the location from launcher metadata; do not promise user-directory redirection. Windows launch has been tested; Linux process detection is untested and macOS startup is unsupported. Process state is only a one-second observation, not proof that the mod loaded. Observe the requested gameplay through the project's playtesting procedure.

Preserve unrelated work. Game and dependency folders are reference inputs. These commands cannot see unsaved editor text, so establish which saved files are intended for the check before relying on the result.

For a change to an existing mod, a baseline can separate old findings from newly introduced ones:

```sh
pxtk validate --write-baseline .px-toolkit/before-change.json --json
# Make the requested edits using the client's normal file tools.
pxtk validate --baseline .px-toolkit/before-change.json --json
```

A baseline file is created once and never overwritten. The equivalent MCP calls are `pxtk_validate` with `{"writeBaseline":".px-toolkit/before-change.json"}`, then `{"baseline":".px-toolkit/before-change.json"}`. Baseline creation is explicitly authorized by writeBaseline; do not add a write boolean. Relative baseline paths are mod-relative. Creation requires complete validation and an existing destination folder inside the mod. Known-unsupported Tiger prevents baseline creation and comparison while keeping findings visible. Do not recreate a baseline after introducing errors to make them disappear. Baseline comparison rejects changed validation inputs. Check the listed reason and establish a fresh baseline before starting a new task or target-version migration.

Report new errors, relevant warnings, unavailable checks, and preserved pre-existing findings. A structural and Tiger pass is static evidence only. Claim runtime behavior only after the actual game behavior has been observed.

`complete: true` means the requested structural checks and Tiger completed without known incompatibility. It does not certify patch compatibility. Read scope when validating selected files: Tiger still checks the whole mod, and its findings remain visible.

The CLI uses exit 0 for completed work without new errors, 1 for new errors/no match/ambiguity, and 2 for unavailable checks or execution failures. Read the JSON status and coverage, not only the process exit code. Do not treat truncated results as the complete set.
