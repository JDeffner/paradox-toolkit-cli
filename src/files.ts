import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { type Configuration } from "./config";
import { LOG_FILES } from "@px-lsp/protocol/constants";
import { resolveConfigPath } from "@px-lsp/protocol/configDir";
import { detectGameVersion } from "@px-lsp/server/index/indexer";
import { ToolError } from "./errors";
import { readSourceFile } from "./source";

const ignored = new Set([
  ".git",
  ".px-toolkit",
  ".ck3modding",
  ".vic3modding",
  ".eu5modding",
  ".local",
  "node_modules",
]);
export function languageFor(file: string): string | null {
  switch (path.extname(file).toLowerCase()) {
    case ".txt":
    case ".asset":
    case ".mod":
      return "paradox";
    case ".gui":
      return "paradox-gui";
    case ".yml":
      return "paradox-loc";
    default:
      return null;
  }
}
export async function contentFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Indexing or validating a symlinked subtree can escape the selected workspace.
        throw new ToolError("linked_content", `Use an ordinary file or directory for mod content: ${file}`);
      }
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && languageFor(file)) out.push(file);
    }
  }
  await walk(root);
  return out.sort();
}
/** Exact editable-input fingerprint; disk writes during a query invalidate its result. */
export async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await contentFiles(root)) {
    const bytes = await fs.readFile(file);
    hash.update(JSON.stringify([path.relative(root, file), bytes.length]));
    hash.update(bytes);
  }
  const metadata = path.join(root, ".metadata/metadata.json");
  try {
    hash.update(await fs.readFile(metadata));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return hash.digest("hex");
}
/** Inputs that must stay fixed while comparing edits to a baseline. */
export async function referenceFingerprint(config: Configuration): Promise<string> {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      config.game,
      config.gamePath,
      config.gamePath ? detectGameVersion(config.gamePath) : null,
      config.logsPath,
      config.parents,
      config.language,
      config.tigerPath,
    ])
  );
  const files = new Set([
    resolveConfigPath(config.mod, config.meta, "schema.json"),
    resolveConfigPath(config.mod, config.meta, "playset.json"),
    resolveConfigPath(config.mod, config.meta, "project.json"),
    resolveConfigPath(config.mod, config.meta, "localization.json"),
    ...(config.configFile ? [config.configFile] : []),
    ...(config.tigerConfig ? [config.tigerConfig] : []),
    ...(config.meta.tiger
      ? [
          resolveConfigPath(config.mod, config.meta, config.meta.tiger.confName),
          path.join(config.mod, config.meta.tiger.confName),
        ]
      : []),
  ]);
  if (config.logsPath) {
    for (const { file } of LOG_FILES) files.add(path.join(config.logsPath, file));
    files.add(path.join(config.logsPath, "on_actions.log"));
    for (const dir of new Set([config.logsPath, path.resolve(config.logsPath, "../logs")])) {
      files.add(path.join(dir, "data_types.log"));
      try {
        for (const name of await fs.readdir(dir)) {
          if (/^data_type.*\.txt$/i.test(name)) files.add(path.join(dir, name));
        }
        const subdir = path.join(dir, "data_types");
        try {
          for (const name of await fs.readdir(subdir)) files.add(path.join(subdir, name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  for (const file of [...files].sort()) {
    hash.update(JSON.stringify(file));
    try {
      const bytes = await fs.readFile(file);
      hash.update(JSON.stringify(bytes.length));
      hash.update(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("missing");
    }
  }
  for (const parent of config.parents) hash.update(await fingerprint(parent));
  return hash.digest("hex");
}
export async function readSource(file: string, line: number, roots: string[]) {
  const source = await readSourceFile(file, roots);
  const lines = source.text.split(/\r?\n/);
  if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length)
    throw new ToolError("invalid_range", "The indexed definition line is outside the source file.");
  const start = Math.max(0, line - 2);
  const end = Math.min(lines.length, line + 16);
  const clippedLines = lines
    .slice(start, end)
    .flatMap((text, index) =>
      text.length > 500 ? [{ line: start + index + 1, startColumn: 501, totalChars: text.length }] : []
    );
  const omittedBefore = start > 0;
  const omittedAfter = end < lines.length;
  return {
    file: source.file,
    line: line + 1,
    contextStart: start + 1,
    context: lines.slice(start, end).map((text) => text.slice(0, 500)),
    totalLines: lines.length,
    sourceHash: source.sourceHash,
    encoding: source.encoding,
    limits: { lineCount: 18, charsPerLine: 500 },
    truncated: omittedBefore || omittedAfter || clippedLines.length > 0,
    omittedBefore,
    omittedAfter,
    clippedLines,
    next: clippedLines.length
      ? { startLine: clippedLines[0].line, startColumn: 501 }
      : omittedAfter
        ? { startLine: end + 1, startColumn: 1 }
        : null,
    continuation: { file: source.file, startLine: 1, startColumn: 1, sourceHash: source.sourceHash },
  };
}
