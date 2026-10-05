import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { MigrationManifest } from "@px-lsp/protocol/migration";
import { MIGRATION_LIMITS, type PreparedMigration } from "@px-lsp/server/migrations";
import {
  assertMigrationSnapshotLimits,
  hashSnapshot,
  validateMigrationVersion,
} from "@px-lsp/server/migrations/engine";
import { planMigrationRoutes } from "@px-lsp/server/migrations/routes";
import {
  captureMigration,
  assertMigrationFresh,
  type MigrationRoots,
} from "@px-lsp/server/migrations/node/files";
import type {
  MigrationWorkerRequest,
  MigrationWorkerResponse,
  RecipeSelection,
} from "@px-lsp/server/migrations/node/runner";
import { detectGameVersion } from "@px-lsp/server/index/indexer";
import { digest, type Configuration } from "./config";
import type { PxtkRequest } from "./contract";
import { errorMessage, ToolError } from "./errors";

const previewChars = 16_000;
const diagnosticChars = 8_000;
const requestSchema = z.object({
  action: z.enum(["catalog", "routes", "preview"]).default("catalog"),
  recipe: z.string().trim().min(1).optional(),
  recipeFile: z.string().min(1).optional(),
  trust: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  fromBuild: z.string().optional(),
  toBuild: z.string().optional(),
  sourceGamePath: z.string().min(1).optional(),
  targetGamePath: z.string().min(1).optional(),
  answers: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  limit: z.number().int().min(1).max(200).default(20),
});

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ToolError("operation_cancelled", "Migration cancelled.");
}

/** Cancellation and crash isolation, not a sandbox for trusted author code. */
async function runWorker(
  request: MigrationWorkerRequest,
  timeoutMs: number,
  diagnostics: { stdout: string; stderr: string; truncated: boolean },
  signal?: AbortSignal
): Promise<MigrationWorkerResponse> {
  cancelled(signal);
  if (request.snapshot) assertMigrationSnapshotLimits(request.snapshot);
  const worker = new Worker(path.join(__dirname, "migrations", "worker.cjs"), {
    workerData: request,
    stdout: true,
    stderr: true,
  });
  const record = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
    const text = chunk.toString();
    const remaining = diagnosticChars - diagnostics.stdout.length - diagnostics.stderr.length;
    diagnostics[stream] += text.slice(0, Math.max(0, remaining));
    if (text.length > remaining) diagnostics.truncated = true;
  };
  worker.stdout?.on("data", (chunk: Buffer) => record("stdout", chunk));
  worker.stderr?.on("data", (chunk: Buffer) => record("stderr", chunk));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: MigrationWorkerResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      // Do not return while author timers or loops can still run.
      void worker.terminate().then(
        () => (error ? reject(error) : resolve(response!)),
        (terminationError: unknown) => reject(error ?? terminationError)
      );
    };
    const cancel = () => finish(new ToolError("operation_cancelled", "Migration cancelled."));
    const timer = setTimeout(
      () =>
        finish(new ToolError("migration_timeout", `Recipe exceeded its ${timeoutMs} ms execution limit.`)),
      timeoutMs
    );
    signal?.addEventListener("abort", cancel, { once: true });
    worker.once("error", (error: unknown) =>
      finish(error instanceof Error ? error : new Error(String(error)))
    );
    worker.once("exit", (code) =>
      finish(new ToolError("migration_failed", `Recipe worker exited before returning a result (${code}).`))
    );
    worker.once("message", (message: { result?: MigrationWorkerResponse; error?: string }) => {
      if (message.error)
        finish(
          new ToolError(
            "migration_failed",
            message.error.length > diagnosticChars
              ? message.error.slice(0, diagnosticChars) + "\n[Recipe error truncated]"
              : message.error
          )
        );
      else if (message.result) finish(undefined, message.result);
      else finish(new ToolError("migration_failed", "Recipe worker returned an invalid result."));
    });
    if (signal?.aborted) cancel();
  });
}

async function readStableFile(file: string, label: string, signal?: AbortSignal) {
  cancelled(signal);
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MIGRATION_LIMITS.fileBytes)
      throw new ToolError("invalid_request", `${label} must be a regular file of at most 32 MiB.`);
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      cancelled(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const final = await handle.stat();
    if (
      offset !== stat.size ||
      final.size !== stat.size ||
      final.mtimeMs !== stat.mtimeMs ||
      final.ctimeMs !== stat.ctimeMs
    )
      throw new ToolError("stale_input", `${label} changed while reading.`);
    const bytes = buffer.subarray(0, offset);
    return { bytes, identity: [stat.dev, stat.ino, stat.birthtimeMs] };
  } finally {
    await handle.close();
  }
}

async function readArtifact(file: string, signal?: AbortSignal) {
  const { bytes } = await readStableFile(file, "Recipe artifact", signal);
  return { sha256: digest(bytes), bytes: bytes.length, ...contentPreview(bytes) };
}

function contentPreview(bytes: Uint8Array) {
  let encoding: "utf8" | "base64" = "utf8";
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes("\0")) throw new Error("Binary content.");
  } catch {
    encoding = "base64";
    content = Buffer.from(bytes).toString("base64");
  }
  return {
    encoding,
    content: content.slice(0, previewChars),
    contentTruncated: content.length > previewChars,
  };
}

function page<T>(items: T[], limit: number) {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

function planPreview(plan: PreparedMigration, limit: number) {
  const { files, ...metadata } = plan;
  return {
    ...metadata,
    files: {
      total: files.length,
      truncated: files.length > limit,
      items: files.slice(0, limit).map((file) => ({
        path: file.path,
        action: !file.before ? "create" : !file.after ? "delete" : "update",
        before: file.before
          ? {
              sha256: digest(Buffer.from(file.before)),
              bytes: file.before.length,
              ...contentPreview(file.before),
            }
          : null,
        after: file.after
          ? {
              sha256: digest(Buffer.from(file.after)),
              bytes: file.after.length,
              ...contentPreview(file.after),
            }
          : null,
      })),
    },
  };
}

async function reference(root: string | undefined, expectedBuild: string, signal?: AbortSignal) {
  cancelled(signal);
  if (!root)
    return {
      path: null,
      detectedBuild: null,
      expectedBuild,
      status: "unavailable",
      identity: null,
      metadata: null,
    };
  let resolved = await fs.realpath(root);
  if (!(await fs.stat(resolved)).isDirectory())
    throw new ToolError("invalid_request", "Migration game root must be a directory.");
  try {
    const game = path.join(resolved, "game");
    if ((await fs.stat(game)).isDirectory()) resolved = await fs.realpath(game);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stat = await fs.stat(resolved);
  const identity = [stat.dev, stat.ino, stat.birthtimeMs];
  // Bind the same launcher file used by the pinned version detector, including
  // its absence. Declared recipe captures normally omit this installation file.
  const metadataFile = path.join(path.dirname(resolved), "launcher", "launcher-settings.json");
  const metadataState = async () => {
    try {
      const captured = await readStableFile(metadataFile, "Game version metadata", signal);
      return {
        file: metadataFile,
        identity: captured.identity,
        sha256: digest(captured.bytes),
        bytes: captured.bytes.length,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  };
  const metadata = await metadataState();
  const detected = detectGameVersion(resolved);
  if (JSON.stringify(await metadataState()) !== JSON.stringify(metadata))
    throw new ToolError("stale_input", "Game version metadata changed while detecting its build.");
  let exact = true;
  try {
    validateMigrationVersion(detected);
  } catch {
    exact = false;
  }
  return {
    path: resolved,
    detectedBuild: exact ? detected : null,
    expectedBuild,
    status: !exact ? "unknown" : detected === expectedBuild ? "matches" : "mismatch",
    identity,
    metadata,
  };
}

export async function migrationReport(
  config: Configuration,
  request: PxtkRequest,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) throw new ToolError("invalid_request", parsed.error.message);
  const input = parsed.data;
  const previewOnly = ["sourceGamePath", "targetGamePath", "answers"] as const;
  const unexpected: string[] =
    input.action === "preview" ? [] : previewOnly.filter((field) => input[field] !== undefined);
  if (input.action === "catalog") {
    if (input.fromBuild !== undefined) unexpected.push("fromBuild");
    if (input.toBuild !== undefined) unexpected.push("toBuild");
  }
  if (unexpected.length)
    throw new ToolError("invalid_request", `${input.action} does not accept: ${unexpected.join(", ")}.`);
  for (const build of [input.fromBuild, input.toBuild]) {
    if (build !== undefined) {
      try {
        validateMigrationVersion(build);
      } catch (error) {
        throw new ToolError("invalid_request", errorMessage(error));
      }
    }
  }
  if (input.action === "routes" && (!input.fromBuild || !input.toBuild))
    throw new ToolError("invalid_request", "Routes require fromBuild and toBuild.");
  if (input.action === "preview" && !input.recipe && !input.recipeFile)
    throw new ToolError("invalid_request", "Preview requires a recipe ID or recipeFile.");
  if (input.trust && !input.recipeFile) throw new ToolError("invalid_request", "Trust requires recipeFile.");
  if (input.recipeFile && !/\.(?:c?js|json)$/i.test(input.recipeFile))
    throw new ToolError(
      "invalid_request",
      "Recipe file must be a self-contained .cjs, .js, or data-only .json artifact."
    );
  cancelled(signal);
  const diagnostics = { stdout: "", stderr: "", truncated: false };
  const result: Record<string, unknown> = {
    mode: input.action === "preview" ? "preview" : "read",
    action: input.action,
    trustRequired: false,
    prepared: false,
    gameplayTested: false,
    trustBoundary:
      "Trusted local recipe code has host process permissions. Workers are not a sandbox. This operation never applies a migration plan.",
    diagnostics,
  };
  const worker = (workerRequest: MigrationWorkerRequest) =>
    runWorker(workerRequest, config.timeoutMs, diagnostics, signal);
  let selection: RecipeSelection | undefined;
  let artifact: Awaited<ReturnType<typeof readArtifact>> | undefined;
  if (input.recipeFile) {
    const file = await fs.realpath(path.resolve(config.mod || process.cwd(), input.recipeFile));
    artifact = await readArtifact(file, signal);
    const trusted = input.trust?.toLowerCase() === artifact.sha256;
    result.artifact = { file, ...artifact, trusted };
    if (input.trust && !trusted)
      throw new ToolError("stale_input", "Recipe trust hash does not match the current artifact.");
    // No parsing, require, discovery, or inspection occurs before this boundary.
    if (!trusted)
      return {
        ...result,
        trustRequired: true,
        blockedReasons: [
          "Explicit trust of the artifact SHA-256 is required before loading its catalog or executing code.",
        ],
      };
    selection = { id: input.recipe, localPath: file, codeHash: artifact.sha256 };
  } else if (input.recipe) selection = { id: input.recipe };
  const loaded = await worker({ action: selection ? "load" : "catalog", gameId: config.game, selection });
  if (loaded.kind !== "catalog" && loaded.kind !== "loaded")
    throw new ToolError("migration_failed", "Invalid catalog response.");
  const manifests = loaded.manifests;
  result.catalog = page(manifests, input.limit);
  const assertArtifactFresh = async () => {
    if (selection?.localPath && (await readArtifact(selection.localPath, signal)).sha256 !== artifact?.sha256)
      throw new ToolError("stale_input", "Recipe artifact changed during migration preview.");
  };
  if (input.action === "catalog") {
    await assertArtifactFresh();
    return result;
  }
  if (input.action === "routes") {
    const routes = planMigrationRoutes(manifests, config.game, input.fromBuild!, input.toBuild!);
    await assertArtifactFresh();
    return {
      ...result,
      routes: page(routes.routes, input.limit),
      versions: routes.versions,
      issues: routes.issues,
    };
  }
  const manifest: MigrationManifest | undefined = input.recipe
    ? manifests.find((item) => item.id === input.recipe)
    : manifests.length === 1
      ? manifests[0]
      : undefined;
  if (!manifest || loaded.kind !== "loaded")
    throw new ToolError("invalid_request", "Select one migration entry ID from the catalog.");
  selection = { ...selection, id: manifest.id, codeHash: loaded.codeHash };
  result.manifest = manifest;
  result.recipeCodeHash = loaded.codeHash;
  const blockedReasons: string[] = [];
  for (const [actual, expected, label] of [
    [input.fromBuild, manifest.fromVersion, "Source"],
    [input.toBuild, manifest.toVersion, "Target"],
  ]) {
    if (actual !== undefined && actual !== expected)
      blockedReasons.push(`${label} build ${actual} does not match recipe build ${expected}.`);
  }
  const requiredRoots = new Set(manifest.inputs.map((item) => item.root));
  const sourceRoot = input.sourceGamePath;
  const targetRoot =
    input.targetGamePath ?? (requiredRoots.has("target") ? (config.gamePath ?? undefined) : undefined);
  const source = await reference(sourceRoot, manifest.fromVersion, signal);
  const target = await reference(targetRoot, manifest.toVersion, signal);
  const assertReferencesFresh = async () => {
    for (const [root, expectedBuild, before] of [
      [sourceRoot, manifest.fromVersion, source],
      [targetRoot, manifest.toVersion, target],
    ] as const) {
      try {
        if (JSON.stringify(await reference(root, expectedBuild, signal)) !== JSON.stringify(before))
          throw new ToolError(
            "stale_input",
            "Migration reference installation or version metadata changed during preview."
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new ToolError(
            "stale_input",
            "Migration reference installation or version metadata was removed during preview."
          );
        throw error;
      }
    }
  };
  result.references = { source, target };
  const roots: MigrationRoots = {
    mod: config.mod,
    ...(source.path ? { source: source.path } : {}),
    ...(target.path ? { target: target.path } : {}),
  };
  for (const root of requiredRoots) {
    if (!roots[root]) blockedReasons.push(`Recipe requires the ${root} input root.`);
  }
  for (const [root, label, evidence] of [
    ["source", "Source", source],
    ["target", "Target", target],
  ] as const) {
    if (!requiredRoots.has(root)) continue;
    if (evidence.status === "mismatch")
      blockedReasons.push(
        `${label} installation build ${evidence.detectedBuild} does not match recipe build ${evidence.expectedBuild}.`
      );
    if (evidence.status === "unknown")
      blockedReasons.push(`${label} installation exact build could not be verified from launcher metadata.`);
  }
  if (blockedReasons.length) {
    await assertArtifactFresh();
    await assertReferencesFresh();
    return { ...result, blockedReasons };
  }
  let snapshot = await captureMigration(roots, manifest, config.game, [], { signal });
  if (manifest.sdkVersion === 2) {
    const seedHash = await hashSnapshot(snapshot);
    const discovery = await worker({
      action: "discover",
      gameId: config.game,
      selection,
      snapshot,
      answers: input.answers,
    });
    if (discovery.kind !== "discovered")
      throw new ToolError("migration_failed", "Invalid discovery response.");
    await assertMigrationFresh(roots, manifest, seedHash, [], snapshot.capture, signal);
    snapshot = await captureMigration(roots, manifest, config.game, [], {
      capture: { selected: discovery.selected },
      signal,
    });
  }
  const snapshotHash = await hashSnapshot(snapshot);
  const inspected = await worker({
    action: "inspect",
    gameId: config.game,
    selection,
    snapshot,
    answers: input.answers,
  });
  if (inspected.kind !== "inspected") throw new ToolError("migration_failed", "Invalid inspection response.");
  Object.assign(result, inspected.result, { snapshotHash });
  if (manifest.kind !== "recipe")
    blockedReasons.push("This advisory supplies guidance and cannot prepare edits.");
  if (inspected.result.inspection.applicability !== "applicable")
    blockedReasons.push(`Recipe applicability is ${inspected.result.inspection.applicability}.`);
  if (inspected.result.missingAnswers.length)
    blockedReasons.push(`Required answers: ${inspected.result.missingAnswers.join(", ")}.`);
  if (inspected.result.invalidAnswers.length)
    blockedReasons.push(`Invalid answers: ${inspected.result.invalidAnswers.join(", ")}.`);
  for (const finding of inspected.result.inspection.findings)
    if (finding.severity === "error") blockedReasons.push(`${finding.id}: ${finding.message}`);
  if (!blockedReasons.length) {
    try {
      const prepared = await worker({
        action: "prepare",
        gameId: config.game,
        selection,
        snapshot,
        answers: inspected.result.answers,
      });
      if (prepared.kind !== "prepared") throw new ToolError("migration_failed", "Invalid prepared response.");
      result.plan = planPreview(prepared.plan, input.limit);
      result.prepared = true;
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== "migration_failed") throw error;
      blockedReasons.push(error.message);
    }
  }
  await assertMigrationFresh(roots, manifest, snapshotHash, [], snapshot.capture, signal);
  await assertArtifactFresh();
  await assertReferencesFresh();
  cancelled(signal);
  return { ...result, blockedReasons };
}
