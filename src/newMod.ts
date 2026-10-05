import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scaffoldDescriptor, wildcardVersion } from "@px-lsp/protocol/descriptorMod";
import { METADATA_REL_PATH, scaffoldMetadata } from "@px-lsp/protocol/descriptorMetadata";
import { detectGameVersion } from "@px-lsp/server/index/indexer";
import { digest, isWithin, requireWorkspace, type Configuration } from "./config";
import type { PxtkRequest } from "./contract";
import { errorMessage, ToolError } from "./errors";
import { targetPath } from "./writes";

async function statOptional(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function identity(stat: NonNullable<Awaited<ReturnType<typeof statOptional>>>) {
  return [stat.dev, stat.ino, stat.birthtimeMs];
}

/** Creation checks ancestors as well as the destination, including dangling links. */
async function destinationState(config: Configuration) {
  const root = path.resolve(config.mod);
  if (root === path.parse(root).root)
    throw new ToolError("invalid_destination", "A filesystem root cannot be a mod destination.");
  for (let current = root; ; current = path.dirname(current)) {
    const info = await statOptional(current);
    if (info) {
      if (info.isSymbolicLink())
        throw new ToolError("linked_destination", "Linked destinations are not writable: " + current);
      if (!info.isDirectory())
        throw new ToolError("invalid_destination", "Destination path is not a directory: " + current);
    }
    if (current === path.dirname(current)) break;
  }
  const parent = await statOptional(path.dirname(root));
  if (!parent) throw new ToolError("invalid_destination", "Create the destination's parent folder first.");
  for (const source of [config.gamePath, ...config.parents]) {
    if (source && (isWithin(source, root) || isWithin(root, source)))
      throw new ToolError("read_only_source", "Editable mod and read-only source overlap: " + source);
  }
  const destination = await statOptional(root);
  if (destination && (await fs.readdir(root)).length)
    throw new ToolError("destination_not_empty", "New mods require an absent or empty destination: " + root);
  return { parent: identity(parent), destination: destination ? identity(destination) : null };
}

/** The profile's verified scaffold paths supply the starter folders, never per-game copies. */
function starterFolders(config: Configuration, fileNames: string[]): string[] {
  const folders = new Set<string>();
  function add(folder: string) {
    for (let current = folder; current !== "."; current = path.posix.dirname(current)) {
      if (current.startsWith("../") || current === ".." || path.posix.isAbsolute(current))
        throw new ToolError("invalid_profile", "Starter folder must be mod-relative: " + folder);
      folders.add(current);
    }
  }
  for (const file of fileNames) add(path.posix.dirname(file));
  for (const stage of config.meta.stageRoots ?? []) add(stage);
  const stage = config.meta.stageRoots?.[0];
  for (const scaffold of config.meta.scaffolds ?? []) {
    for (const file of [scaffold.scriptPath, scaffold.locPath]) {
      if (!file) continue;
      let folder = path.posix.dirname(file.replaceAll("$LANG$", config.language));
      if (folder.includes("$"))
        throw new ToolError("invalid_profile", "Unresolved starter folder: " + folder);
      if (stage && !config.meta.stageRoots!.some((root) => folder === root || folder.startsWith(root + "/")))
        folder = path.posix.join(stage, folder);
      add(folder);
    }
  }
  return [...folders].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

export async function createMod(
  config: Configuration,
  request: PxtkRequest,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  requireWorkspace(config);
  if (!request.output?.trim() || !request.name?.trim())
    throw new ToolError("invalid_arguments", "Supply a destination folder and display name.");
  if (request.write && request.check) throw new ToolError("invalid_arguments", "Choose --check or --write.");
  if (request.write && !request.expect)
    throw new ToolError(
      "preview_required",
      "Generate a preview, then apply its token with --write --expect."
    );
  const name = request.name.trim();
  if ([...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new ToolError("invalid_name", "The display name cannot contain control characters.");
  if (config.meta.descriptor === "mod" && name.includes("\\"))
    throw new ToolError("invalid_name", "Display names in .mod descriptors cannot contain backslashes.");
  const supportedVersion =
    request.supportedVersion ??
    (config.gamePath ? wildcardVersion(detectGameVersion(config.gamePath)) : null) ??
    "*";
  if (!/^(?:\*|\d+(?:\.\d+)*(?:\.\*)?)$/.test(supportedVersion))
    throw new ToolError("invalid_version", "Use a numeric game version, optionally ending in .*, or *.");
  const id =
    name
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "mod";
  const descriptor = config.meta.descriptor === "mod" ? "descriptor.mod" : METADATA_REL_PATH;
  const text =
    config.meta.descriptor === "mod"
      ? "\uFEFF" + scaffoldDescriptor(name, supportedVersion)
      : scaffoldMetadata({ name, id, supportedGameVersion: supportedVersion });
  const files = [
    { file: descriptor, content: text },
    {
      file: ".px-toolkit/pxtk.json",
      content: JSON.stringify({ game: config.game, mod: ".", language: config.language }, null, 2) + "\n",
    },
  ].map((file) => ({ ...file, bytes: Buffer.from(file.content) }));
  const folders = starterFolders(
    config,
    files.map((file) => file.file)
  );
  const state = await destinationState(config);
  for (const name of [...folders, ...files.map((file) => file.file)]) await targetPath(config, name);
  const token = digest(
    JSON.stringify({
      destination: config.mod,
      state,
      folders,
      files: files.map((file) => [file.file, digest(file.bytes)]),
    })
  );
  if (request.expect && request.expect !== token)
    throw new ToolError("stale_preview", "Destination or options changed. Generate a fresh preview.");
  const written: string[] = [];
  const createdFolders: string[] = [];
  if (request.write) {
    let rootIdentity = state.destination;
    const ownedFiles = new Map<string, Buffer>();
    const ownedFolders = new Set<string>();
    const assertOwned = async () => {
      signal?.throwIfAborted();
      // Recheck the full ancestor boundary after each await that precedes a mutation.
      for (const file of files) await targetPath(config, file.file);
      for (let current = config.mod; ; current = path.dirname(current)) {
        const info = await fs.lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new ToolError("linked_destination", "Destination path changed: " + current);
        if (current === path.dirname(current)) break;
      }
      const rootStat = await fs.lstat(config.mod);
      if (JSON.stringify(identity(rootStat)) !== JSON.stringify(rootIdentity))
        throw new ToolError("stale_preview", "Destination folder was replaced.");
      if (JSON.stringify(identity(await fs.lstat(path.dirname(config.mod)))) !== JSON.stringify(state.parent))
        throw new ToolError("stale_preview", "Destination parent folder was replaced.");
      const found = new Set<string>();
      async function walk(dir: string): Promise<void> {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          const rel = path.relative(config.mod, file).replace(/\\/g, "/");
          found.add(rel);
          if (entry.isSymbolicLink())
            throw new ToolError("linked_destination", "Destination changed: " + file);
          if (entry.isDirectory() && ownedFolders.has(rel)) await walk(file);
          else if (entry.isFile() && ownedFiles.has(rel)) {
            const info = await fs.lstat(file);
            if (info.nlink > 1 || !(await fs.readFile(file)).equals(ownedFiles.get(rel)!))
              throw new ToolError("stale_preview", "Destination changed: " + file);
          } else throw new ToolError("stale_preview", "Destination gained content: " + file);
        }
      }
      await walk(config.mod);
      if ([...ownedFolders, ...ownedFiles.keys()].some((name) => !found.has(name)))
        throw new ToolError("stale_preview", "Created content was removed during creation.");
    };
    try {
      if (JSON.stringify(await destinationState(config)) !== JSON.stringify(state))
        throw new ToolError("stale_preview", "Destination changed. Generate a fresh preview.");
      signal?.throwIfAborted();
      if (state.destination === null) {
        await fs.mkdir(config.mod);
        createdFolders.push(config.mod);
        rootIdentity = identity(await fs.lstat(config.mod));
      }
      for (const folder of folders) {
        await assertOwned();
        const file = await targetPath(config, folder);
        await fs.mkdir(file);
        ownedFolders.add(folder);
        createdFolders.push(file);
      }
      for (const file of files) {
        await assertOwned();
        const destination = await targetPath(config, file.file);
        await fs.writeFile(destination, file.bytes, { flag: "wx", signal });
        ownedFiles.set(file.file, file.bytes);
        written.push(destination);
      }
      await assertOwned();
    } catch (error) {
      // Keep completed work and concurrent user content. Do not recursively roll back a destination.
      throw new ToolError(
        "write_failed",
        errorMessage(error) +
          "\nCompleted files: " +
          JSON.stringify(written) +
          "\nCreated folders: " +
          JSON.stringify(createdFolders)
      );
    }
  }
  return {
    mode: request.write ? "written" : request.check ? "check" : "preview",
    previewToken: token,
    changed: files.length,
    written,
    files: files.map((file) => ({
      file: file.file,
      action: "create",
      beforeSha256: null,
      afterSha256: digest(file.bytes),
      bytes: file.bytes.length,
      content: file.content,
      contentTruncated: false,
    })),
    destination: config.mod,
    name,
    descriptor,
    supportedVersion,
    folders,
    launcherRegistered: false,
    nextSteps: [
      config.meta.descriptor === "mod"
        ? `Register this mod in the ${config.meta.name} launcher with a .mod pointer to the destination, then add it to a playset.`
        : `Register this mod in the ${config.meta.name} launcher. For an external mod folder, create a folder link in the game's mod folder, then add it to a playset.`,
      ...(config.meta.descriptor === "metadata"
        ? ["Add a square thumbnail.png to the mod root before a Workshop upload."]
        : []),
      ...(supportedVersion === "*"
        ? [
            "The installed game version is unknown. Set the descriptor's supported version before distribution.",
          ]
        : []),
    ],
  };
}
