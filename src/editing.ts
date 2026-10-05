import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ResponseError } from "vscode-jsonrpc";
import type { Range, TextEdit, WorkspaceEdit } from "vscode-languageserver";
import type { DefinitionEditResult, GuiTextEdit } from "@px-lsp/protocol/protocol";
import { parseScript } from "@px-lsp/server/parser";
import type { PxtkRequest } from "./contract";
import { digest, requireWorkspace, type Configuration } from "./config";
import { ToolError, errorMessage } from "./errors";
import { fingerprint, languageFor, referenceFingerprint } from "./files";
import { withSession } from "./lsp";
import { readSourceFile } from "./source";
import { finishChanges, targetPath, type Change } from "./writes";

interface SavedSource {
  file: string;
  text: string;
  bytes: Buffer;
}

function requirePreview(request: PxtkRequest): void {
  if (request.write && !request.expect)
    throw new ToolError("preview_required", "Review a preview and supply its expect token before writing.");
}

async function source(
  config: Configuration,
  name: string | undefined,
  scriptOnly = true
): Promise<SavedSource> {
  if (!name) throw new ToolError("file_required", "Supply a saved file inside the editable mod.");
  const file = await targetPath(config, name);
  if (!languageFor(file) || (scriptOnly && languageFor(file) !== "paradox"))
    throw new ToolError("unsupported_edit", "This operation requires a saved script file.");
  const saved = await readSourceFile(file, [config.mod]);
  if (saved.encoding === "latin1-fallback")
    throw new ToolError("unsupported_encoding", "Save the source as UTF-8 before editing it.");
  const bytes = await fs.readFile(saved.file);
  if (digest(bytes) !== saved.sourceHash)
    throw new ToolError("source_changed", "Source changed while reading. Generate a fresh preview.");
  return { file: saved.file, text: saved.text, bytes };
}

async function inputIdentity(config: Configuration, applied: readonly Change[] = []) {
  return digest(
    JSON.stringify([
      await fingerprint(config.mod, new Map(applied.map((change) => [change.file, change.before]))),
      await referenceFingerprint(config),
    ])
  );
}

function offset(text: string, line: number, character: number): number {
  if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0)
    throw new ToolError("invalid_range", "Positions must be nonnegative UTF-16 coordinates.");
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  if (line >= starts.length) throw new ToolError("invalid_range", "Position is beyond the source file.");
  let end = starts[line + 1] === undefined ? text.length : starts[line + 1] - 1;
  if (end > starts[line] && text[end - 1] === "\r") end--;
  if (starts[line] + character > end)
    throw new ToolError("invalid_range", "Position is beyond the source line.");
  return starts[line] + character;
}

function rangeEdit(text: string, edit: TextEdit): GuiTextEdit {
  return {
    start: offset(text, edit.range.start.line, edit.range.start.character),
    end: offset(text, edit.range.end.line, edit.range.end.character),
    newText: edit.newText,
  };
}

/** Apply every provider edit against one original text, or refuse the whole set. */
function apply(text: string, edits: GuiTextEdit[]): string {
  for (const edit of edits) {
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > text.length ||
      typeof edit.newText !== "string"
    )
      throw new ToolError("invalid_edit", "The language server returned an invalid source edit.");
  }
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => b.edit.start - a.edit.start || b.edit.end - a.edit.end || b.index - a.index);
  let lastStart = Infinity;
  let output = text;
  for (const { edit } of ordered) {
    if (edit.end > lastStart)
      throw new ToolError("overlapping_edits", "The language server returned overlapping source edits.");
    output = output.slice(0, edit.start) + edit.newText + output.slice(edit.end);
    lastStart = edit.start;
  }
  return output;
}

function change(saved: SavedSource, edits: GuiTextEdit[]): Change {
  const text = apply(saved.text, edits);
  const language = languageFor(saved.file);
  const bom =
    language === "paradox" ||
    language === "paradox-loc" ||
    saved.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
      ? "\uFEFF"
      : "";
  return { file: saved.file, before: saved.bytes, after: Buffer.from(bom + text), text: true };
}

function coverage() {
  return {
    sources: "Saved editable mod files only. Dependency and vanilla destinations are refused.",
    identity:
      "All indexable mod and dependency content, configuration and generated documentation. Vanilla uses installation path and detected version; concurrent manual vanilla edits require a fresh preview.",
    validation:
      "Provider edit ranges and resulting definition-edit syntax only; static validation and gameplay remain separate checks.",
    offsets: "UTF-16 offsets in the original decoded text, without the UTF-8 BOM.",
    encoding:
      "Script and localization writes use UTF-8 with BOM. Existing text and line endings are preserved.",
  };
}

async function finish(
  config: Configuration,
  request: PxtkRequest,
  before: string,
  changes: Change[],
  edits: Array<{ file: string; edits: GuiTextEdit[] }>,
  identity: unknown,
  signal?: AbortSignal
) {
  return {
    ...(await finishChanges(config, request, changes, [], signal, {
      identity: digest(JSON.stringify([before, identity])),
      assertUnchanged: async (applied) => {
        if ((await inputIdentity(config, applied)) !== before)
          throw new ToolError("stale_preview", "Indexed inputs changed. Generate a fresh preview.");
      },
    })),
    edits: edits.map((entry) => ({
      file: path.relative(config.mod, entry.file).replace(/\\/g, "/"),
      edits: entry.edits,
    })),
    coverage: coverage(),
  };
}

function refused(error: unknown): never {
  if (error instanceof ResponseError) throw new ToolError("rename_refused", errorMessage(error));
  throw error;
}

/** Use the pinned server's complete prepare/rename refusal and reference policy. */
export async function renameSymbol(
  config: Configuration,
  request: PxtkRequest,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  requireWorkspace(config);
  requirePreview(request);
  if (!request.to) throw new ToolError("name_required", "Supply the new symbol name in to.");
  if (
    !Number.isSafeInteger(request.line) ||
    request.line! < 1 ||
    !Number.isSafeInteger(request.column) ||
    request.column! < 1
  )
    throw new ToolError("invalid_range", "line and column must be positive 1-based UTF-16 coordinates.");
  const before = await inputIdentity(config);
  const saved = await source(config, request.file, false);
  const position = { line: request.line! - 1, character: request.column! - 1 };
  offset(saved.text, position.line, position.character);
  return withSession(
    config,
    async (session) =>
      session.withDocument(saved.file, languageFor(saved.file)!, saved.text, async (uri) => {
        const range = await session
          .request<Range | null>("textDocument/prepareRename", { textDocument: { uri }, position })
          .catch(refused);
        if (!range) throw new ToolError("rename_refused", "No supported rename target at this position.");
        const from = saved.text.slice(
          offset(saved.text, range.start.line, range.start.character),
          offset(saved.text, range.end.line, range.end.character)
        );
        const proposal = await session
          .request<WorkspaceEdit | null>("textDocument/rename", {
            textDocument: { uri },
            position,
            newName: request.to,
          })
          .catch(refused);
        if (!proposal) throw new ToolError("rename_refused", "The language server did not return a rename.");
        if (proposal.changes && proposal.documentChanges)
          throw new ToolError("invalid_edit", "The rename returned conflicting workspace edit formats.");
        const entries: Array<[string, TextEdit[]]> = Object.entries(proposal.changes ?? {});
        for (const entry of proposal.documentChanges ?? []) {
          if ("kind" in entry)
            throw new ToolError("invalid_edit", "Rename cannot create, remove or move files.");
          const edits = entry.edits.map((edit) => {
            if (!("newText" in edit))
              throw new ToolError("invalid_edit", "Rename cannot apply snippet edits.");
            return edit;
          });
          entries.push([entry.textDocument.uri, edits]);
        }
        const grouped = new Map<string, { saved: SavedSource; edits: GuiTextEdit[] }>();
        for (const [uri, providerEdits] of entries) {
          const file = fileURLToPath(uri);
          const current = await source(config, file, false);
          const key = current.file.toLowerCase();
          const entry = grouped.get(key) ?? { saved: current, edits: [] };
          entry.edits.push(...providerEdits.map((edit) => rangeEdit(current.text, edit)));
          grouped.set(key, entry);
        }
        if (!grouped.size) throw new ToolError("rename_refused", "The rename returned no source edits.");
        const entriesSorted = [...grouped.values()].sort((a, b) => a.saved.file.localeCompare(b.saved.file));
        return {
          ...(await finish(
            config,
            request,
            before,
            entriesSorted.map((entry) => change(entry.saved, entry.edits)),
            entriesSorted.map((entry) => ({ file: entry.saved.file, edits: entry.edits })),
            ["rename", saved.file, request.line, request.column, request.to],
            signal
          )),
          from,
          to: request.to,
          coverage: {
            ...coverage(),
            references:
              "The pinned LSP's indexed script and localization references. Dynamic names and unindexed reference forms can be missed; unsupported symbol types are refused by the provider.",
          },
        };
      }),
    signal
  );
}

/** Apply the pinned definition writer's surgical operations without reserialization. */
export async function editDefinition(
  config: Configuration,
  request: PxtkRequest,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  requireWorkspace(config);
  requirePreview(request);
  if (!request.edits?.length) throw new ToolError("edits_required", "Supply definition edit operations.");
  const before = await inputIdentity(config);
  const saved = await source(config, request.file);
  return withSession(
    config,
    async (session) => {
      const proposal = await session.request<DefinitionEditResult>("paradox/definitionEdit", {
        uri: pathToFileURL(saved.file).href,
        text: saved.text,
        ops: request.edits,
      });
      if (proposal.ops.length !== request.edits!.length)
        throw new ToolError(
          "invalid_edit",
          "The definition writer did not report every requested operation."
        );
      const refusals = proposal.ops.flatMap((op, index) =>
        op.refused ? [`Operation ${index + 1}: ${op.refused}`] : []
      );
      if (refusals.length) throw new ToolError("edit_refused", refusals.join("\n"));
      const changed = change(saved, proposal.edits);
      if (parseScript(changed.after.toString("utf8").replace(/^\uFEFF/, "")).errors.length)
        throw new ToolError("invalid_edit", "The requested edits would produce invalid script syntax.");
      return {
        ...(await finish(
          config,
          request,
          before,
          [changed],
          [{ file: saved.file, edits: proposal.edits }],
          ["edit", saved.file, request.edits],
          signal
        )),
        ops: proposal.ops,
      };
    },
    signal
  );
}
