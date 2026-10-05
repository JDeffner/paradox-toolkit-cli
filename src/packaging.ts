import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseDescriptor, readDescriptorBlock, validateDescriptor } from "@px-lsp/protocol/descriptorMod";
import { METADATA_REL_PATH } from "@px-lsp/protocol/descriptorMetadata";
import { digest, isWithin, requireWorkspace, type Configuration } from "./config";
import type { PxtkRequest } from "./contract";
import { errorMessage, ToolError } from "./errors";
import {
  workflowCreateFile,
  workflowExpect,
  workflowIdentity,
  workflowMode,
  workflowPathState,
  workflowStat,
} from "./importing";
import { packageFilter } from "./packagePolicy";
import { utf8 } from "./writes";

interface FileEntry {
  file: string;
  bytes: number;
  sha256: string;
}
interface Finding {
  level: "error" | "warn";
  file: string;
  message: string;
}
async function outputState(config: Configuration, destination: string) {
  for (const source of [config.mod, config.gamePath, ...config.parents]) {
    if (source && (isWithin(source, destination) || isWithin(destination, source)))
      throw new ToolError(
        "read_only_source",
        "Release destination must be outside the mod and source folders: " + source
      );
  }
  const state = await workflowPathState(destination);
  if (state[0].identity)
    throw new ToolError("destination_exists", "Release destination already exists: " + destination);
  const parent = await workflowStat(path.dirname(destination));
  if (!parent?.isDirectory())
    throw new ToolError("invalid_destination", "Create the release destination's parent folder first.");
  const canonical = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
  for (const source of [config.mod, config.gamePath, ...config.parents]) {
    if (source && (isWithin(source, canonical) || isWithin(canonical, source)))
      throw new ToolError("read_only_source", "Release destination resolves into a source folder: " + source);
  }
  return state;
}
function page<T>(items: T[], limit: number) {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

/** Build a local release directory. No Steam connection, archive, descriptor rewrite, or source writes. */
export async function packageMod(
  config: Configuration,
  request: PxtkRequest,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  requireWorkspace(config);
  const mode = workflowMode(request);
  if (!request.output?.trim())
    throw new ToolError("invalid_arguments", "Supply an external release destination folder.");
  const destination = path.resolve(request.output);
  const limit = request.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new ToolError("invalid_arguments", "The result limit must be between 1 and 200.");
  const initialOutput = await outputState(config, destination);
  const sourcePathState = await workflowPathState(config.mod);
  const ignoreFile = path.join(config.mod, ".pxignore");
  const ignoreStat = await workflowStat(ignoreFile);
  if (
    ignoreStat?.isSymbolicLink() ||
    (ignoreStat && !ignoreStat.isFile()) ||
    (ignoreStat && ignoreStat.nlink > 1)
  )
    throw new ToolError("linked_path", "The ignore policy must be a regular unlinked file.");
  const ignoreBytes = ignoreStat ? await fs.readFile(ignoreFile, { signal }) : null;
  const keep = packageFilter(ignoreBytes === null ? null : utf8(ignoreBytes));
  async function snapshot() {
    const included: FileEntry[] = [];
    const excluded: Array<{ file: string; reason: string }> = [];
    const folders: string[] = [];
    const state: unknown[] = [];
    async function walk(directory: string) {
      signal?.throwIfAborted();
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        signal?.throwIfAborted();
        const full = path.join(directory, entry.name);
        const file = path.relative(config.mod, full).replace(/\\/g, "/");
        const info = await fs.lstat(full);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
          throw new ToolError("linked_path", "Release sources cannot contain links: " + file);
        if (!info.isDirectory() && !info.isFile())
          throw new ToolError("invalid_source", "Release source is not a file or directory: " + file);
        state.push([file, workflowIdentity(info), info.size, info.mtimeMs]);
        const reason = keep(file, info.isDirectory());
        if (reason) {
          excluded.push({ file: file + (info.isDirectory() ? "/" : ""), reason });
          continue;
        }
        if (info.isDirectory()) {
          folders.push(file);
          await walk(full);
        } else {
          const bytes = await fs.readFile(full, { signal });
          included.push({ file, bytes: bytes.length, sha256: digest(bytes) });
        }
      }
    }
    await walk(config.mod);
    const currentIgnore = await workflowStat(ignoreFile);
    const currentIgnoreBytes = currentIgnore ? await fs.readFile(ignoreFile, { signal }) : null;
    if (
      currentIgnoreBytes === null
        ? ignoreBytes !== null
        : ignoreBytes === null || !currentIgnoreBytes.equals(ignoreBytes)
    )
      throw new ToolError("stale_preview", "The release ignore policy changed.");
    return { included, excluded, folders, state };
  }
  const source = await snapshot();
  const descriptor = config.meta.descriptor === "mod" ? "descriptor.mod" : METADATA_REL_PATH;
  const findings: Finding[] = [];
  // Toolkit steam/workshop.ts findPreview prefers descriptor picture, then these root files.
  const previewCandidates = ["thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"];
  const descriptorEntry = source.included.find((file) => file.file === descriptor);
  if (!descriptorEntry)
    findings.push({ level: "error", file: descriptor, message: "The mod descriptor is missing." });
  else {
    const text = utf8(await fs.readFile(path.join(config.mod, descriptor), { signal }));
    if (digest(Buffer.from(text)) !== descriptorEntry.sha256)
      throw new ToolError("stale_preview", "The mod descriptor changed during preview.");
    if (config.meta.descriptor === "mod") {
      for (const issue of validateDescriptor(text, { isDescriptorFile: true }))
        findings.push({
          level: issue.severity === "error" ? "error" : "warn",
          file: descriptor,
          message: issue.message,
        });
      const values = parseDescriptor(text);
      const picture = values
        .find((entry) => entry.key === "picture")
        ?.value.replace(/^"|"$/g, "")
        .replace(/\\/g, "/");
      if (picture) previewCandidates.unshift(picture);
      const name = values
        .find((entry) => entry.key === "name")
        ?.value.replace(/^"|"$/g, "")
        .trim();
      if (!name)
        findings.push({ level: "error", file: descriptor, message: "The descriptor has no display name." });
      if (!values.some((entry) => entry.key === "supported_version" && entry.value !== '""'))
        findings.push({
          level: "warn",
          file: descriptor,
          message: "The descriptor has no supported game version.",
        });
      if (!readDescriptorBlock(text, "tags").length)
        findings.push({ level: "warn", file: descriptor, message: "The descriptor has no tags." });
    } else {
      try {
        const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("Metadata must be an object.");
        const metadata = raw as Record<string, unknown>;
        for (const field of ["name", "id"])
          if (typeof metadata[field] !== "string" || !(metadata[field] as string).trim())
            findings.push({ level: "error", file: descriptor, message: "Metadata has no " + field + "." });
        if (typeof metadata.supported_game_version !== "string" || !metadata.supported_game_version.trim())
          findings.push({
            level: "warn",
            file: descriptor,
            message: "Metadata has no supported game version.",
          });
        if (!Array.isArray(metadata.tags) || !metadata.tags.length)
          findings.push({ level: "warn", file: descriptor, message: "Metadata has no tags." });
      } catch (error) {
        findings.push({
          level: "error",
          file: descriptor,
          message: "Invalid metadata: " + errorMessage(error),
        });
      }
    }
  }
  // Toolkit's local preflight warns about a blank preview tile.
  if (!source.included.some((entry) => previewCandidates.includes(entry.file)))
    findings.push({
      level: "warn",
      file: "thumbnail.png",
      message:
        "No descriptor preview or root thumbnail image is included. Check the listing preview before publication.",
    });
  const token = digest(
    JSON.stringify({
      destination,
      initialOutput,
      sourcePathState,
      source,
      policy: ignoreBytes && digest(ignoreBytes),
      findings,
    })
  );
  workflowExpect(request, token);
  const written: string[] = [];
  const partial: string[] = [];
  const createdFolders: string[] = [];
  const ownedFolders = new Map<string, number[]>();
  let ownedState = initialOutput;
  const assertDestination = async () => {
    signal?.throwIfAborted();
    if (JSON.stringify(await workflowPathState(destination)) !== JSON.stringify(ownedState))
      throw new ToolError("stale_preview", "Release destination or its parent changed.");
    if (JSON.stringify(await workflowPathState(config.mod)) !== JSON.stringify(sourcePathState))
      throw new ToolError("stale_preview", "Mod source folder changed.");
  };
  const assertOutputPath = async (output: string) => {
    for (const entry of await workflowPathState(output)) {
      const owned = ownedFolders.get(entry.file);
      if (owned && JSON.stringify(owned) !== JSON.stringify(entry.identity))
        throw new ToolError("stale_preview", "A created release folder changed: " + entry.file);
    }
  };
  if (request.write) {
    if (findings.some((finding) => finding.level === "error"))
      throw new ToolError(
        "package_not_ready",
        "Fix descriptor errors before staging the release: " + JSON.stringify(findings)
      );
    try {
      await assertDestination();
      if (JSON.stringify(await snapshot()) !== JSON.stringify(source))
        throw new ToolError("stale_preview", "Mod content changed before staging.");
      await fs.mkdir(destination);
      createdFolders.push(destination);
      const createdRoot = workflowIdentity(await fs.lstat(destination));
      ownedState = initialOutput.map((entry) =>
        entry.file === destination ? { ...entry, identity: createdRoot } : entry
      );
      for (const folder of source.folders) {
        await assertDestination();
        const output = path.join(destination, folder);
        await assertOutputPath(output);
        await fs.mkdir(output);
        createdFolders.push(output);
        ownedFolders.set(output, workflowIdentity(await fs.lstat(output)));
      }
      for (const entry of source.included) {
        await assertDestination();
        const input = path.join(config.mod, entry.file);
        await workflowPathState(input);
        const bytes = await fs.readFile(input, { signal });
        if (digest(bytes) !== entry.sha256)
          throw new ToolError("stale_preview", "Mod source changed: " + entry.file);
        const output = path.join(destination, entry.file);
        await assertOutputPath(output);
        await workflowCreateFile(output, bytes, partial, signal);
        written.push(output);
      }
      await assertDestination();
      if (JSON.stringify(await snapshot()) !== JSON.stringify(source))
        throw new ToolError("stale_preview", "Mod content changed during staging.");
      const found = new Set<string>();
      async function verifyOutput(directory: string): Promise<void> {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const full = path.join(directory, entry.name);
          const relative = path.relative(destination, full).replace(/\\/g, "/");
          found.add(relative);
          await assertOutputPath(full);
          if (entry.isDirectory() && source.folders.includes(relative)) await verifyOutput(full);
          else if (entry.isFile()) {
            const wanted = source.included.find((file) => file.file === relative);
            if (!wanted || digest(await fs.readFile(full, { signal })) !== wanted.sha256)
              throw new ToolError("stale_preview", "Release content changed: " + relative);
          } else throw new ToolError("stale_preview", "Release gained unexpected content: " + relative);
        }
      }
      await verifyOutput(destination);
      if ([...source.folders, ...source.included.map((file) => file.file)].some((file) => !found.has(file)))
        throw new ToolError("stale_preview", "Created release content was removed.");
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
    destination,
    changed: source.included.length,
    written,
    totalFiles: source.included.length,
    totalBytes: source.included.reduce((total, entry) => total + entry.bytes, 0),
    included: page(source.included, limit),
    excluded: page(source.excluded, limit),
    findings: page(findings, limit),
    ready: !findings.some((finding) => finding.level === "error"),
  };
}
