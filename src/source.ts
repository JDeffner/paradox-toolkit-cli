import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decode } from "@px-lsp/server/parser";
import { digest, isWithin, type Configuration } from "./config";
import { ToolError } from "./errors";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".gui",
  ".asset",
  ".mod",
  ".yml",
  ".yaml",
  ".json",
  ".info",
  ".lua",
  ".gfx",
  ".sfx",
  ".shader",
  ".csv",
  ".md",
]);

export interface SourceReadRequest {
  file?: string;
  startLine?: number;
  lineCount?: number;
  startColumn?: number;
  maxChars?: number;
  sourceHash?: string;
}
export interface SourcePosition {
  startLine: number;
  startColumn: number;
}
export interface SourcePage extends SourcePosition {
  file: string;
  endLine: number;
  endColumn: number;
  text: string;
  context: string[];
  totalLines: number;
  sourceHash: string;
  encoding: "utf8" | "utf8-bom" | "latin1-fallback";
  truncated: boolean;
  omittedBefore: boolean;
  omittedAfter: boolean;
  next: SourcePosition | null;
}

/** Source reads use canonical roots so a linked file cannot extend their boundary. */
export async function readSourceFile(file: string, roots: string[]) {
  const realRoots = await Promise.all(roots.map((root) => fs.realpath(root)));
  const real = await fs.realpath(file);
  if (!realRoots.some((root) => isWithin(root, real)))
    throw new ToolError(
      "outside_sources",
      "Source file must be inside the configured mod, parents, or game data."
    );
  if (!TEXT_EXTENSIONS.has(path.extname(real).toLowerCase()))
    throw new ToolError(
      "unsupported_source",
      "Source reading supports Paradox text files and text documentation."
    );
  const handle = await fs.open(real, "r");
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ToolError("unsupported_source", "Source must be an ordinary text file.");
    if (stat.size > MAX_SOURCE_BYTES)
      throw new ToolError("source_too_large", "Source reading is limited to files of 16 MiB.");
    // A bounded read also covers a file that grows after stat().
    bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > stat.size)
      throw new ToolError("source_changed", "Source changed while reading. Read the source again.");
    bytes = bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
  // UTF-16 and binary content contain controls which are not Paradox source text.
  if (bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || bytes.includes(127))
    throw new ToolError(
      "unsupported_source",
      "Binary or unsupported text encoding cannot be read as source."
    );
  const decoded = decode(bytes);
  return { file: real, ...decoded, sourceHash: digest(bytes) };
}

function integer(value: number | undefined, fallback: number, name: string, maximum?: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || (maximum !== undefined && result > maximum))
    throw new ToolError(
      "invalid_range",
      `${name} must be an integer from 1${maximum ? ` to ${maximum}` : ""}.`
    );
  return result;
}

/** Columns and character budgets count UTF-16 code units, including a CR before LF. */
export async function readSourcePage(config: Configuration, request: SourceReadRequest): Promise<SourcePage> {
  if (typeof request.file !== "string" || !request.file.trim())
    throw new ToolError("file_required", "Source reading requires a file path.");
  const startLine = integer(request.startLine, 1, "startLine");
  const startColumn = integer(request.startColumn, 1, "startColumn");
  const lineCount = integer(request.lineCount, 100, "lineCount", 200);
  const maxChars = integer(request.maxChars, 16000, "maxChars", 64000);
  if (request.sourceHash !== undefined && !/^[a-f0-9]{64}$/i.test(request.sourceHash))
    throw new ToolError("invalid_source_hash", "sourceHash must be a SHA-256 hash.");
  const source = await readSourceFile(path.resolve(config.mod, request.file), [
    config.mod,
    ...config.parents,
    ...(config.gamePath ? [config.gamePath] : []),
  ]);
  if (request.sourceHash !== undefined && request.sourceHash.toLowerCase() !== source.sourceHash)
    throw new ToolError(
      "source_changed",
      "Source changed since the previous read. Restart reading this file."
    );
  const starts = [0];
  for (let offset = 0; offset < source.text.length; offset++)
    if (source.text[offset] === "\n") starts.push(offset + 1);
  const totalLines = starts.length;
  if (startLine > totalLines) throw new ToolError("invalid_range", "startLine is beyond the source file.");
  const lineEnd = startLine < totalLines ? starts[startLine] - 1 : source.text.length;
  const start = starts[startLine - 1] + startColumn - 1;
  if (start > lineEnd) throw new ToolError("invalid_range", "startColumn is beyond the source line.");
  const end = Math.min(
    source.text.length,
    starts[startLine - 1 + lineCount] ?? source.text.length,
    start + maxChars
  );
  let endIndex = startLine - 1;
  while (endIndex + 1 < totalLines && starts[endIndex + 1] <= end) endIndex++;
  const endLine = endIndex + 1;
  const endColumn = end - starts[endIndex] + 1;
  const omittedBefore = start > 0;
  const omittedAfter = end < source.text.length;
  const text = source.text.slice(start, end);
  return {
    file: source.file,
    startLine,
    startColumn,
    endLine,
    endColumn,
    text,
    context: text.split(/\r?\n/),
    totalLines,
    sourceHash: source.sourceHash,
    encoding: source.encoding,
    truncated: omittedBefore || omittedAfter,
    omittedBefore,
    omittedAfter,
    next: omittedAfter ? { startLine: endLine, startColumn: endColumn } : null,
  };
}
