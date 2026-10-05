import * as fs from "node:fs/promises";
import * as path from "node:path";
import { analyzePatch } from "@px-lsp/server/compatch/engine";
import { capturePatchSources, assertPatchSourcesFresh } from "@px-lsp/server/compatch/node";
import type { PatchEntry, PatchProject } from "@px-lsp/server/compatch/model";
import type { Configuration } from "./config";
import { digest, isWithin } from "./config";
import type { PxtkRequest } from "./contract";
import { ToolError, errorMessage } from "./errors";

const pathKey = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
const overlaps = (left: string, right: string) =>
  isWithin(pathKey(left), pathKey(right)) || isWithin(pathKey(right), pathKey(left));

function conflictExplanation(entry: PatchEntry): string {
  if (entry.winner) return entry.explanation;
  // Core can remove a provisional winner after composing its explanation.
  // Describe the final result from structured data, without rewriting its prose.
  const suppressed = entry.contributors.filter((contributor) => !contributor.active).length;
  const absent = !entry.contributors.some((contributor) => contributor.active);
  return `${suppressed} contribution(s) suppressed by whole-file shadowing. No proven effective contribution.${absent ? " The definition is absent from the effective files and requires review." : ""} See issues and contributor reasons for unresolved details.`;
}

async function sourceRoots(values: string[], config: Configuration): Promise<string[]> {
  if (!values.length || values.length > 200)
    throw new ToolError("invalid_inputs", "Supply between 1 and 200 ordered mod folders.");
  const roots: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim())
      throw new ToolError("invalid_inputs", "Each conflict input must be a mod folder.");
    const selected = path.resolve(value);
    const stat = await fs.lstat(selected);
    const canonical = await fs.realpath(selected);
    if (!stat.isDirectory() || stat.isSymbolicLink() || pathKey(selected) !== pathKey(canonical))
      throw new ToolError("invalid_inputs", `Input must be a directory without linked aliases: ${selected}`);
    if (roots.some((other) => overlaps(other, canonical)))
      throw new ToolError("invalid_inputs", `Duplicate or overlapping conflict input: ${selected}`);
    if (config.gamePath && overlaps(config.gamePath, canonical))
      throw new ToolError(
        "invalid_inputs",
        `Conflict inputs must be mods outside the game folder: ${selected}`
      );
    const descriptor = path.join(
      canonical,
      config.meta.descriptor === "mod" ? "descriptor.mod" : ".metadata/metadata.json"
    );
    const metadata = await fs.lstat(descriptor);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      pathKey(await fs.realpath(descriptor)) !== pathKey(descriptor)
    )
      throw new ToolError("invalid_inputs", `Input needs a regular mod descriptor: ${descriptor}`);
    roots.push(canonical);
  }
  return roots;
}

async function captureBoundary(roots: string[]): Promise<string> {
  // Core capture shares its root validation with the patch writer and requires
  // an existing disjoint output root. Capture never reads or writes that root.
  const selected = await fs.realpath(path.dirname(process.execPath));
  if (roots.some((root) => overlaps(root, selected)))
    throw new ToolError(
      "invalid_inputs",
      "Conflict inputs cannot overlap the Node executable folder because core capture requires a disjoint host boundary."
    );
  return selected;
}

export async function reportConflicts(
  config: Configuration,
  request: PxtkRequest,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const limit = request.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new ToolError("invalid_limit", "Conflict limit must be between 1 and 200.");
  const window = <T>(items: T[]) => ({
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
  });
  const policy = config.meta.compatchComposition;
  const coverage = {
    policyRevision: policy?.revision ?? null,
    evidence: policy?.evidence ?? [],
    limits: [
      "Only explicitly selected mods, or configured parents followed by the editable mod, are scanned. Vanilla is not included.",
      "Input order is first loaded first; individual folder precedence follows the selected game profile.",
      "Cross-file ordinary definition precedence and replace_path suppression are not certified; unknown winners remain null.",
      "Binary assets require external review. The fingerprint records their inventory metadata, not binary contents.",
      "This is a saved-file composition report, not deep validation or a gameplay compatibility certificate.",
    ],
    savedFilesOnly: true,
    gameplayTested: false,
  };
  const empty = {
    game: config.game,
    inputOrder: "first-loaded-first",
    inputs: [],
    sourceFingerprint: null,
    sourceCount: 0,
    fileCount: 0,
    conflicts: window([]),
    coverage,
  };
  try {
    signal?.throwIfAborted();
    const roots = await sourceRoots(request.inputs ?? [...config.parents, config.mod], config);
    if (!policy)
      return {
        ...empty,
        supported: false,
        issues: window([`No verified composition policy is available for ${config.meta.shortName}.`]),
      };
    const project: PatchProject = {
      version: 1,
      id: "pxtk-conflicts",
      gameId: config.game,
      name: "Conflict report",
      inputs: roots.map((root, index) => ({ id: `input-${index + 1}`, name: path.basename(root) })),
      decisions: {},
      generated: {},
    };
    const bindings = {
      output: await captureBoundary(roots),
      sources: Object.fromEntries(project.inputs.map((input, index) => [input.id, roots[index]])),
    };
    const capture = await capturePatchSources(project, bindings, policy, { signal });
    const analysis = await analyzePatch(capture.snapshot, project, policy);
    await assertPatchSourcesFresh(capture, project, bindings, policy, { signal });
    signal?.throwIfAborted();
    return {
      ...empty,
      supported: true,
      inputs: capture.snapshot.sources.map((source) => ({
        id: source.id,
        path: capture.bindings.sources[source.id],
        name: source.name,
        version: source.version ?? null,
        replacePaths: window(source.replacePaths),
        dependencies: window(source.dependencies),
      })),
      sourceFingerprint: digest(
        JSON.stringify({
          roots: capture.bindings.sources,
          snapshot: capture.snapshot,
          inventory: capture.inventory,
          policy,
        })
      ),
      sourceCount: analysis.sourceCount,
      fileCount: analysis.fileCount,
      conflicts: window(
        analysis.entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          state: entry.state,
          fingerprint: entry.fingerprint,
          explanation: conflictExplanation(entry),
          winner: entry.winner ?? null,
          contributors: window(
            entry.contributors.map((contributor) => ({
              id: contributor.id,
              sourceId: contributor.sourceId,
              sourceName: contributor.sourceName,
              path: contributor.path,
              active: contributor.active,
              reason: contributor.reason ?? null,
            }))
          ),
          issues: window(entry.issues),
        }))
      ),
      issues: window(analysis.issues),
    };
  } catch (error) {
    if (signal?.aborted || error instanceof ToolError) throw error;
    throw new ToolError("conflict_scan_failed", errorMessage(error));
  }
}
