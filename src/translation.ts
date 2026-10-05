import * as path from "node:path";
import {
  buildTranslation,
  detectLocFileLanguage,
  mergeTranslation,
  retargetLocPath,
} from "@px-lsp/protocol/translationCore";
import { generatedLocalizationSource } from "@px-lsp/protocol/localizationPolicy";
import { parseLoc } from "@px-lsp/server/parser";
import { requireWorkspace, type Configuration } from "./config";
import type { PxtkRequest } from "./contract";
import { ToolError } from "./errors";
import { contentFiles } from "./files";
import { finishChanges, readOptional, targetPath, utf8, type Change, type InputSnapshot } from "./writes";

interface LocalizationFile {
  file: string;
  text: string;
  bytes: Buffer;
  entries: ReturnType<typeof parseLoc>["entries"];
}

function parsedFile(file: string, bytes: Buffer, language: string): LocalizationFile {
  const text = utf8(bytes);
  const body = text.replace(/^\uFEFF/, "");
  const headers = body.split(/\r\n|\r|\n/).filter((line) => /^[ \t]*l_[a-z_]+:[ \t]*(?:#.*)?$/.test(line));
  const parsed = parseLoc(text);
  if (headers.length !== 1 || parsed.language !== language)
    throw new ToolError("invalid_header", `Localization needs a single l_${language}: header: ${file}`);
  if (parsed.errors.length)
    throw new ToolError("invalid_localization", `Cannot synchronize malformed localization: ${file}`);
  const seen = new Set<string>();
  for (const entry of parsed.entries) {
    if (seen.has(entry.key))
      throw new ToolError("duplicate_localization", `Several entries define ${entry.key}: ${file}`);
    seen.add(entry.key);
  }
  return { file, text, bytes, entries: parsed.entries };
}

function uniqueKeys(files: LocalizationFile[]): Set<string> {
  const owners = new Map<string, string>();
  for (const file of files) {
    for (const entry of file.entries) {
      const owner = owners.get(entry.key);
      if (owner)
        throw new ToolError(
          "ambiguous_localization",
          `Several files define ${entry.key}: ${owner}, ${file.file}`
        );
      owners.set(entry.key, file.file);
    }
  }
  return new Set(owners.keys());
}

function authored(file: LocalizationFile): void {
  const generated = generatedLocalizationSource(file.text);
  if (generated)
    throw new ToolError("generated_localization", `Use the source workflow for ${file.file}: ${generated}`);
}

/** Mirror missing source keys as blank entries, preserving existing translations. */
export async function syncLocalization(
  config: Configuration,
  request: PxtkRequest,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  requireWorkspace(config);
  const sourceLanguage = request.sourceLanguage;
  const targetLanguage = request.language;
  if (
    !sourceLanguage ||
    !targetLanguage ||
    !/^[a-z][a-z_]*$/.test(sourceLanguage) ||
    !/^[a-z][a-z_]*$/.test(targetLanguage) ||
    sourceLanguage === targetLanguage
  )
    throw new ToolError("invalid_languages", "Supply different source and target localization languages.");
  if (request.write && !request.expect)
    throw new ToolError(
      "preview_required",
      "Generate a preview, then apply its token with --write --expect."
    );
  const roots = [...(config.meta.stageRoots ?? []).map((stage) => `${stage}/localization/`), "localization/"];
  const relative = (file: string) => path.relative(config.mod, file).replace(/\\/g, "/");
  const fileKey = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file);
  const inLocalization = (file: string) => roots.some((root) => relative(file).startsWith(root));
  const selected = request.file ? await targetPath(config, request.file) : null;
  if (selected && (!inLocalization(selected) || detectLocFileLanguage(selected) !== sourceLanguage))
    throw new ToolError(
      "invalid_loc_file",
      "Select a source-language file in a profile localization folder."
    );

  const inputs: InputSnapshot[] = [];
  const sources: LocalizationFile[] = [];
  const targets: LocalizationFile[] = [];
  const relevantFiles = async () =>
    (await contentFiles(config.mod)).filter((file) => {
      const language = detectLocFileLanguage(file);
      return (
        inLocalization(file) &&
        path.extname(file).toLowerCase() === ".yml" &&
        (language === sourceLanguage || language === targetLanguage)
      );
    });
  const inventory = await relevantFiles();
  for (const file of inventory) {
    signal?.throwIfAborted();
    const language = detectLocFileLanguage(file)!;
    if (!file.toLowerCase().endsWith(`_l_${language}.yml`))
      throw new ToolError("invalid_loc_file", "Localization filename must carry its language: " + file);
    const bytes = await readOptional(file);
    if (bytes === null) throw new ToolError("stale_preview", "Source changed: " + file);
    inputs.push({ file, bytes });
    const parsed = parsedFile(file, bytes, language);
    (language === sourceLanguage ? sources : targets).push(parsed);
  }
  uniqueKeys(sources);
  const targetKeys = uniqueKeys(targets);
  const selectedSources = selected
    ? sources.filter((source) => fileKey(source.file) === fileKey(selected))
    : sources;
  if (!selectedSources.length)
    throw new ToolError("source_not_found", "No source-language localization files were found.");
  const targetFiles = new Map(targets.map((target) => [fileKey(target.file), target]));
  const changes: Change[] = [];
  const mappings: Array<{ source: string; target: string; added: number }> = [];
  let addedKeys = 0;
  for (const source of selectedSources) {
    signal?.throwIfAborted();
    authored(source);
    const destination = retargetLocPath(relative(source.file), sourceLanguage, targetLanguage);
    if (!destination)
      throw new ToolError(
        "invalid_loc_file",
        "Source path has no localization language marker: " + source.file
      );
    const file = await targetPath(config, destination);
    if (!inLocalization(file) || !file.toLowerCase().endsWith(`_l_${targetLanguage}.yml`))
      throw new ToolError("invalid_loc_file", "Translation destination is not a profile localization file.");
    const target = targetFiles.get(fileKey(file));
    const before = target?.bytes ?? (await readOptional(file));
    if (before !== null && !target) throw new ToolError("stale_preview", "Destination changed: " + file);
    if (target) authored(target);
    // Keys already translated in another target file must not be duplicated.
    const missing = new Set(
      source.entries.filter((entry) => !targetKeys.has(entry.key)).map((entry) => entry.key)
    );
    inputs.push({ file, bytes: before });
    mappings.push({ source: relative(source.file), target: relative(file), added: missing.size });
    if (!missing.size) continue;
    const sourceLines = source.text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
    const entryLines = new Map(source.entries.map((entry) => [entry.line, entry.key]));
    const missingSource = sourceLines
      .filter((_, line) => !entryLines.has(line) || missing.has(entryLines.get(line)!))
      .join("\n");
    let after: string;
    if (target) {
      // Use the core's blank entries and reference comments, but retain every
      // original target byte, including trailing blank lines and its EOL style.
      const entriesOnly = sourceLines.filter((_, line) => missing.has(entryLines.get(line) ?? "")).join("\n");
      const appended = mergeTranslation("", entriesOnly, sourceLanguage);
      if (appended.added !== missing.size)
        throw new ToolError("invalid_localization", "Translation helpers did not retain every missing key.");
      const body = target.text.replace(/^\uFEFF/, "");
      const eol = /\r\n|\r|\n/.exec(body)?.[0] ?? "\n";
      after = "\uFEFF" + body + (/\r$|\n$/.test(body) ? "" : eol) + appended.content.replace(/\n/g, eol);
    } else after = buildTranslation(missingSource, targetLanguage, sourceLanguage);
    parsedFile(file, Buffer.from(after), targetLanguage);
    changes.push({ file, before, after: Buffer.from(after), text: true });
    addedKeys += missing.size;
    for (const key of missing) targetKeys.add(key);
  }
  return {
    sourceLanguage,
    targetLanguage,
    addedKeys,
    mappings,
    ...(await finishChanges(config, request, changes, inputs, signal, {
      identity: JSON.stringify([config.game, sourceLanguage, targetLanguage, selected, inventory]),
      assertUnchanged: async (applied) => {
        const expected = [...new Set([...inventory, ...applied.map((change) => change.file)])].sort();
        if (JSON.stringify(await relevantFiles()) !== JSON.stringify(expected))
          throw new ToolError("stale_preview", "Localization files changed. Generate a fresh preview.");
      },
    })),
  };
}
