import { parseArgs } from "node:util";
import { createReadStream } from "node:fs";
import type { PxtkOperation, PxtkResult, PxtkRequest } from "./contract";
import { type ConfigInput } from "./config";
import { resolveRequest } from "./resolveRequest";
import { execute, exitCode } from "./operations";
import { errorMessage, ToolError } from "./errors";
import { serveMcp } from "./mcp";
import { version } from "../package.json";

const HELP = `pxtk ${version} - Paradox Modding Toolkit

Usage:
  pxtk status [options]
  pxtk search <text> [--kind <kind>] [--limit <1..200>] [options]
  pxtk inspect <name> [--kind <kind>] [options]
  pxtk read <file> [--start-line <n>] [--line-count <n>] [--source-hash <hash>] [options]
  pxtk impact <name> [--kind <kind>] [options]
  pxtk conflicts [--input <mod> ...] [--limit <1..200>] [options]
  pxtk rename --file <file> --line <n> --column <n> --to <name> [--write --expect <token>]
  pxtk edit --file <file> --operations <json-file> [--write --expect <token>]
  pxtk import --source <game-relative-file> | --directory <game-relative-folder> [--write --expect <token>]
  pxtk package --output <new-folder> [--write --expect <token>]
  pxtk migrate catalog [--recipe-file <file> --trust <sha256>]
  pxtk migrate routes --from <build> --to <build>
  pxtk migrate preview --recipe <id> [--answers <json-file>] [--source-game-path <folder>] [--target-game-path <folder>]
  pxtk validate [--baseline <file>] [--write-baseline <new-file>] [options]
  pxtk mcp [options]
  pxtk playsets --game <id> [options]
  pxtk launch [--playset <id-or-name>] [--preset <id>] [--arg=<argument> ...] [--start --expect <token>]
  pxtk launch [options] -- <game arguments...>
  pxtk init [--write]
  pxtk new <folder> --name <display-name> --game <id> [--supported-version <version>] [--write --expect <token>]
  pxtk create [kind] [name] [--prefix <prefix>] [--stage <stage>] [--write]
  pxtk loc get|set|check [key] [--value <text>] [--file <file>] [--write]
  pxtk loc sync --source-language <name> --language <name> [--file <source-file>] [--write --expect <token>]
  pxtk logs [read|checkpoint] [--file <log>] [--since <checkpoint>] [--output <new-file>] [--write]
  pxtk format <files...> [--check | --write]
  pxtk image inspect <files-or-folders...>
  pxtk image convert <files-or-folders...> --to png|jpeg|webp|dds --output <file-or-folder> [--write]

Preparation options:
  --expect <token>     Reject a stale preview when applying --write or --start
  --width <pixels>     Resize image width (height is optional)
  --height <pixels>    Resize image height (width is optional)
  --fit <mode>         contain (default), cover, inside or fill
  --background <color> Required for JPEG when pixels are transparent
  --dds <format>      auto (default), bc1, bc3 or bgra8; no mipmaps
  --examples          Include a separate sourced example list in inspect
  --templates         Include measured script templates in inspect
  --start-column <n>  Source page starting column (1-based; default 1)
  --max-chars <n>     Source page character budget (default 16000; max 64000)
  --start-line <n>    Source page starting line (1-based; default 1)
  --line-count <n>    Source page line budget (default 100; max 200)
  --source-hash <hash> Reject source continuation after a saved edit
  --start             Start a reviewed launch with --expect; otherwise preview
  --arg=<argument>    Append one exact game argument; repeat for each argument
  --preset <id>       Add a game preset listed by playsets
  --operations <file> JSON array of setProperties/upsertBlock operations for edit
  --answers <file>    JSON object of migration question IDs and string/boolean answers
  --recipe-file <file> Local migration artifact; inspect its hash before using --trust
  --trust <sha256>    Trust exact local recipe code with host permissions (not sandboxed)

Options:
  --game <id>          Required game selection (or PX_GAME_ID / config)
  --mod <folder>       Editable mod folder; defaults to the project folder
  --game-path <path>   Game install or data folder; Steam detection if omitted
  --logs-path <path>   Folder containing generated script_docs
  --tiger <path>       Tiger executable
  --tiger-config <file> Existing Tiger configuration
  --user-data-path <folder> Game's existing user-data folder (launcher database and load settings)
  --parent <folder>   Dependency mod; repeat in load order, base first
  --config <file>     JSON config; default: nearest .px-toolkit/pxtk.json
  --language <name>   Localization language (default: english)
  --timeout <seconds> Operation timeout (default: 300)
  --json              Versioned JSON output; errors are JSON too
  --help              Show this help
  --version           Show the installed version

Commands read saved files. Utility writes need --write; the default is a preview.
Rename, edit, import, package and loc sync also require the matching --expect token.
Migration commands review plans only. Trusted local recipes can execute arbitrary code.
Vanilla and dependencies are read-only. Image outputs never replace existing files.
Baselines use exclusive creation and never replace an existing file.
Exit codes: 0 = success/no new errors, 1 = findings/no match/ambiguity,
2 = invalid input, incomplete validation, or execution failure.
`;
async function jsonArgument(file: string): Promise<unknown> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of createReadStream(file)) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error("JSON input exceeds 4 MiB.");
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    throw new ToolError("invalid_arguments", `Cannot read JSON input ${file}: ${errorMessage(error)}`);
  }
}
function human(result: PxtkResult): string {
  const lines = [
    `pxtk ${result.operation}: ${result.status}`,
    `Game: ${result.sources.game} ${result.sources.gameVersion} | Docs: ${result.sources.documentation}`,
    `Mod: ${result.sources.mod}`,
  ];
  if (result.operation === "validate") {
    const data = result.data;
    lines.push(`New errors: ${data.newErrors}; existing findings: ${data.existingFindings}`);
  }
  lines.push(JSON.stringify(result.data, null, 2));
  if (result.warnings.length) lines.push(...result.warnings.map((warning) => `Note: ${warning}`));
  return lines.join("\n") + "\n";
}
async function main(): Promise<void> {
  const optionEnd = process.argv.indexOf("--");
  const json = process.argv.slice(2, optionEnd === -1 ? undefined : optionEnd).includes("--json");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        game: { type: "string" },
        mod: { type: "string" },
        "game-path": { type: "string" },
        "logs-path": { type: "string" },
        tiger: { type: "string" },
        "tiger-config": { type: "string" },
        parent: { type: "string", multiple: true },
        config: { type: "string" },
        language: { type: "string" },
        timeout: { type: "string" },
        kind: { type: "string" },
        limit: { type: "string" },
        baseline: { type: "string" },
        "write-baseline": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
        version: { type: "boolean" },
        write: { type: "boolean" },
        check: { type: "boolean" },
        expect: { type: "string" },
        file: { type: "string" },
        output: { type: "string" },
        value: { type: "string" },
        prefix: { type: "string" },
        stage: { type: "string" },
        since: { type: "string" },
        to: { type: "string" },
        dds: { type: "string" },
        width: { type: "string" },
        height: { type: "string" },
        fit: { type: "string" },
        background: { type: "string" },
        examples: { type: "boolean" },
        templates: { type: "boolean" },
        name: { type: "string" },
        "supported-version": { type: "string" },
        "start-line": { type: "string" },
        "start-column": { type: "string" },
        "line-count": { type: "string" },
        "max-chars": { type: "string" },
        "source-hash": { type: "string" },
        "user-data-path": { type: "string" },
        playset: { type: "string" },
        preset: { type: "string" },
        arg: { type: "string", multiple: true },
        start: { type: "boolean" },
        input: { type: "string", multiple: true },
        line: { type: "string" },
        column: { type: "string" },
        operations: { type: "string" },
        source: { type: "string" },
        directory: { type: "string" },
        "source-language": { type: "string" },
        recipe: { type: "string" },
        "recipe-file": { type: "string" },
        trust: { type: "string" },
        from: { type: "string" },
        "source-game-path": { type: "string" },
        "target-game-path": { type: "string" },
        answers: { type: "string" },
      },
    });
    if (parsed.values.version) {
      process.stdout.write(json ? JSON.stringify({ schemaVersion: 1, version }) + "\n" : version + "\n");
      return;
    }
    if (parsed.values.help || !parsed.positionals.length) {
      process.stdout.write(json ? JSON.stringify({ schemaVersion: 1, version, help: HELP }) + "\n" : HELP);
      return;
    }
    const [operation, term, ...extra] = parsed.positionals;
    if (
      ![
        "status",
        "search",
        "inspect",
        "read",
        "new",
        "impact",
        "validate",
        "mcp",
        "launch",
        "playsets",
        "init",
        "create",
        "loc",
        "logs",
        "format",
        "image",
        "conflicts",
        "rename",
        "edit",
        "import",
        "package",
        "migrate",
      ].includes(operation)
    )
      throw new ToolError("unknown_command", `Unknown command: ${operation}. Run pxtk --help.`);
    const maxTerms = ["create", "loc"].includes(operation)
      ? 2
      : ["image", "format", "validate", "launch"].includes(operation)
        ? Infinity
        : ["search", "inspect", "impact", "logs", "read", "new", "migrate"].includes(operation)
          ? 1
          : 0;
    if (parsed.positionals.length - 1 > maxTerms)
      throw new ToolError(
        "invalid_arguments",
        "Unexpected positional argument. Quote search text containing spaces."
      );
    const v = parsed.values;
    if (v.operations !== undefined && operation !== "edit")
      throw new ToolError("invalid_arguments", "--operations belongs to edit.");
    if (v.answers !== undefined && operation !== "migrate")
      throw new ToolError("invalid_arguments", "--answers belongs to migrate.");
    if (v.kind !== undefined && operation === "create")
      throw new ToolError("invalid_arguments", "create takes its kind as a positional argument, not --kind.");
    if (v.name !== undefined && operation !== "new")
      throw new ToolError("invalid_arguments", "--name belongs to new. Other commands use positional names.");
    if (operation === "new" && (v.mod !== undefined || v.output !== undefined))
      throw new ToolError(
        "invalid_arguments",
        "new takes its destination as a positional folder, not --mod or --output."
      );
    if (operation === "read" && v.file !== undefined)
      throw new ToolError("invalid_arguments", "read takes its source as a positional file, not --file.");
    if ((v.baseline || v["write-baseline"]) && operation !== "validate")
      throw new ToolError("invalid_arguments", "Baseline options belong to validate.");
    if (v.baseline && v["write-baseline"])
      throw new ToolError("invalid_arguments", "Choose baseline comparison or baseline creation.");
    const overrides: ConfigInput = {
      ...(v.game !== undefined ? { game: v.game } : {}),
      ...(v.mod !== undefined ? { mod: v.mod } : {}),
      ...(v["game-path"] !== undefined ? { gamePath: v["game-path"] } : {}),
      ...(v["logs-path"] !== undefined ? { logsPath: v["logs-path"] } : {}),
      ...(v.tiger !== undefined ? { tigerPath: v.tiger } : {}),
      ...(v["tiger-config"] !== undefined ? { tigerConfig: v["tiger-config"] } : {}),
      ...(v["user-data-path"] !== undefined ? { userDataPath: v["user-data-path"] } : {}),
      ...(v.parent !== undefined ? { parents: v.parent } : {}),
      ...(v.language !== undefined ? { language: v.language } : {}),
      ...(v.timeout !== undefined ? { timeout: Number(v.timeout) } : {}),
    };
    const configOptions = { config: v.config, overrides };
    if (operation === "mcp") {
      await serveMcp(configOptions, controller.signal);
      return;
    }
    const request: PxtkRequest = {
      operation: operation as PxtkOperation,
      query: operation === "search" ? term : undefined,
      name:
        operation === "create" || operation === "loc"
          ? extra[0]
          : operation === "new"
            ? v.name
            : ["inspect", "impact"].includes(operation)
              ? term
              : undefined,
      kind: operation === "create" ? term : v.kind,
      limit: v.limit === undefined ? undefined : Number(v.limit),
      baseline: v.baseline,
      writeBaseline: v["write-baseline"],
      action: ["loc", "logs", "image", "migrate"].includes(operation) ? term : undefined,
      files:
        operation === "image"
          ? extra
          : ["format", "validate"].includes(operation) && term
            ? [term, ...extra]
            : undefined,
      write: v.write,
      check: v.check,
      expect: v.expect,
      file: operation === "read" ? term : v.file,
      output: operation === "new" ? term : v.output,
      value: v.value,
      prefix: v.prefix,
      stage: v.stage,
      since: v.since,
      format: !["rename", "migrate"].includes(operation) ? (v.to as PxtkRequest["format"]) : undefined,
      dds: v.dds as PxtkRequest["dds"],
      width: v.width === undefined ? undefined : Number(v.width),
      height: v.height === undefined ? undefined : Number(v.height),
      fit: v.fit as PxtkRequest["fit"],
      background: v.background,
      examples: v.examples,
      templates: v.templates,
      supportedVersion: v["supported-version"],
      startLine: v["start-line"] === undefined ? undefined : Number(v["start-line"]),
      startColumn: v["start-column"] === undefined ? undefined : Number(v["start-column"]),
      lineCount: v["line-count"] === undefined ? undefined : Number(v["line-count"]),
      maxChars: v["max-chars"] === undefined ? undefined : Number(v["max-chars"]),
      sourceHash: v["source-hash"],
      playset: v.playset,
      preset: v.preset,
      args: operation === "launch" ? [...(v.arg ?? []), ...(term ? [term, ...extra] : [])] : v.arg,
      start: v.start,
      language: ["loc", "create"].includes(operation) ? v.language : undefined,
      sourceLanguage: v["source-language"],
      inputs: v.input,
      line: v.line === undefined ? undefined : Number(v.line),
      column: v.column === undefined ? undefined : Number(v.column),
      to: operation === "rename" ? v.to : undefined,
      edits:
        v.operations === undefined ? undefined : ((await jsonArgument(v.operations)) as PxtkRequest["edits"]),
      source: v.source,
      directory: v.directory,
      recipe: v.recipe,
      recipeFile: v["recipe-file"],
      trust: v.trust,
      fromBuild: v.from,
      toBuild: operation === "migrate" ? v.to : undefined,
      sourceGamePath: v["source-game-path"],
      targetGamePath: v["target-game-path"],
      answers:
        v.answers === undefined ? undefined : ((await jsonArgument(v.answers)) as PxtkRequest["answers"]),
    };
    const result = await execute(await resolveRequest(configOptions, request), request, {
      signal: controller.signal,
    });
    process.stdout.write(json ? JSON.stringify(result) + "\n" : human(result));
    process.exitCode = exitCode(result);
  } catch (error) {
    const argumentError =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("ERR_PARSE_ARGS_");
    const output = {
      schemaVersion: 1,
      status: "error",
      error: {
        code:
          error instanceof ToolError ? error.code : argumentError ? "invalid_arguments" : "operation_failed",
        message: errorMessage(error),
      },
    };
    if (json) process.stdout.write(JSON.stringify(output) + "\n");
    else process.stderr.write(`pxtk: ${output.error.message}\n`);
    process.exitCode = 2;
  }
}
void main();
