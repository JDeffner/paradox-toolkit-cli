import * as fs from "node:fs/promises";
import * as path from "node:path";
import { digest, requireWorkspace, type Configuration } from "./config";
import type { PxtkRequest } from "./contract";
import { errorMessage, ToolError } from "./errors";
import { targetPath } from "./writes";

export async function workflowStat(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function workflowIdentity(stat: NonNullable<Awaited<ReturnType<typeof workflowStat>>>) {
  return [stat.dev, stat.ino, stat.birthtimeMs];
}
/** Track exclusive creations before writing, so interruptions never conceal partial files. */
export async function workflowCreateFile(
  file: string,
  bytes: Buffer,
  partial: string[],
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const handle = await fs.open(file, "wx");
  partial.push(file);
  try {
    await handle.writeFile(bytes, { signal });
  } finally {
    await handle.close();
  }
  partial.splice(partial.lastIndexOf(file), 1);
}
/** Bind every existing ancestor, and refuse links rather than following them. */
export async function workflowPathState(file: string) {
  const state: Array<{ file: string; identity: number[] | null }> = [];
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const info = await workflowStat(current);
    if (info) {
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
        throw new ToolError("linked_path", "Linked paths are not supported: " + current);
      if (current !== path.resolve(file) && !info.isDirectory())
        throw new ToolError("invalid_path", "An ancestor is not a directory: " + current);
    }
    state.push({ file: current, identity: info ? workflowIdentity(info) : null });
    if (current === path.dirname(current)) break;
  }
  return state;
}
export function workflowMode(request: PxtkRequest) {
  if (request.write && request.check) throw new ToolError("invalid_arguments", "Choose --check or --write.");
  if (request.write && !request.expect)
    throw new ToolError(
      "preview_required",
      "Generate a preview, then apply its token with --write --expect."
    );
  return request.write ? "written" : request.check ? "check" : "preview";
}
export function workflowExpect(request: PxtkRequest, token: string) {
  if (request.expect && request.expect !== token)
    throw new ToolError(
      "stale_preview",
      "Inputs, destination, or options changed. Generate a fresh preview."
    );
}
function relativeSource(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(name) ||
    normalized.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)) ||
    /[<>:"|?*]/.test(normalized) ||
    [...normalized].some((character) => character.charCodeAt(0) < 32)
  )
    throw new ToolError("invalid_source", "Select a game-relative file or directory without traversal.");
  return normalized;
}

/** Copy one exact on-disk resource, or create only the selected directory path. */
export async function importVanilla(
  config: Configuration,
  request: PxtkRequest,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  requireWorkspace(config);
  const mode = workflowMode(request);
  if (!config.gamePath)
    throw new ToolError("game_required", "Configure a game folder before importing vanilla content.");
  if (Boolean(request.source) === Boolean(request.directory))
    throw new ToolError("invalid_arguments", "Supply exactly one source file or directory.");
  const kind = request.directory ? "directory" : "file";
  const relative = relativeSource(request.directory ?? request.source!);
  const source = path.join(config.gamePath, relative);
  const destination = await targetPath(config, relative);
  const sourceState = await workflowPathState(source);
  const info = await workflowStat(source);
  if (!info || (kind === "file" ? !info.isFile() : !info.isDirectory()))
    throw new ToolError("invalid_source", "Select an existing vanilla " + kind + ": " + relative);
  let targetState = await workflowPathState(destination);
  if (targetState[0].identity)
    throw new ToolError("destination_exists", "The selected mod path already exists: " + relative);
  const bytes = kind === "file" ? await fs.readFile(source, { signal }) : null;
  const token = digest(
    JSON.stringify({ kind, source, destination, sourceState, targetState, sha256: bytes && digest(bytes) })
  );
  workflowExpect(request, token);
  const folders = targetState
    .filter((entry) => !entry.identity && (kind === "directory" || entry.file !== destination))
    .map((entry) => entry.file)
    .reverse();
  const written: string[] = [];
  const partial: string[] = [];
  const createdFolders: string[] = [];
  const assertCurrent = async () => {
    signal?.throwIfAborted();
    await targetPath(config, relative);
    if (
      JSON.stringify(await workflowPathState(source)) !== JSON.stringify(sourceState) ||
      JSON.stringify(await workflowPathState(destination)) !== JSON.stringify(targetState) ||
      (bytes && !(await fs.readFile(source, { signal })).equals(bytes))
    )
      throw new ToolError("stale_preview", "Source or destination changed during import.");
  };
  await assertCurrent();
  if (request.write) {
    try {
      for (const folder of folders) {
        await assertCurrent();
        await fs.mkdir(folder);
        createdFolders.push(folder);
        const created = workflowIdentity(await fs.lstat(folder));
        targetState = targetState.map((entry) =>
          entry.file === folder ? { ...entry, identity: created } : entry
        );
      }
      if (bytes) {
        await assertCurrent();
        await workflowCreateFile(destination, bytes, partial, signal);
        written.push(destination);
        const created = workflowIdentity(await fs.lstat(destination));
        targetState = targetState.map((entry) =>
          entry.file === destination ? { ...entry, identity: created } : entry
        );
      }
      await assertCurrent();
      if (bytes && !(await fs.readFile(destination, { signal })).equals(bytes))
        throw new ToolError("stale_preview", "The imported file changed during creation.");
    } catch (error) {
      throw new ToolError(
        "write_failed",
        errorMessage(error) +
          "\nCompleted files: " +
          JSON.stringify(written) +
          "\nPartial files: " +
          JSON.stringify(partial) +
          "\nCreated folders: " +
          JSON.stringify(createdFolders)
      );
    }
  }
  return {
    mode,
    previewToken: token,
    changed: 1,
    written,
    source,
    destination,
    kind,
    folders: folders.map((folder) => path.relative(config.mod, folder).replace(/\\/g, "/")),
    files: bytes
      ? [
          {
            file: relative,
            action: "create",
            beforeSha256: null,
            afterSha256: digest(bytes),
            bytes: bytes.length,
          },
        ]
      : [],
  };
}
