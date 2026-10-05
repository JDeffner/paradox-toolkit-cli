import { z } from "zod";
import type { PxtkOperation } from "./contract";
import { findingSchema } from "./validation";

const count = z.number().int().nonnegative();
const position = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const strings = z.array(z.string());
const record = z.record(z.string(), z.unknown());
const window = (item: z.ZodType) => z.object({ items: z.array(item), total: count, truncated: z.boolean() });
const cursor = z.object({ startLine: position, startColumn: position });
const compatibility = z.object({
  status: z.enum(["unknown", "unsupported"]),
  gameVersion: z.string().nullable(),
  validatorVersion: z.string().nullable(),
  evidence: z.string().nullable(),
  reason: z.string(),
});
const sources = z.object({
  game: z.string(),
  gamePath: z.string().nullable(),
  gameVersion: z.string(),
  mod: z.string(),
  parents: strings,
  logsPath: z.string().nullable(),
  documentation: z.enum(["generated", "bundled", "wiki", "none", "unknown"]),
  documentationMatchesGame: z.literal("unknown"),
  serverVersion: z.string(),
  savedFilesOnly: z.literal(true),
});
const write = z
  .object({
    mode: z.enum(["preview", "check", "written"]),
    previewToken: hash.describe("Use as expect with the same request and write=true."),
    changed: count,
    written: strings,
    files: z.array(
      z.object({
        file: z.string(),
        action: z.enum(["create", "update"]),
        beforeSha256: hash.nullable(),
        afterSha256: hash,
        bytes: count,
        content: z.string().optional(),
        contentTruncated: z.boolean().optional(),
      })
    ),
  })
  .passthrough();
const symbol = z.object({ name: z.string(), kind: z.number(), location: record }).passthrough();
const dependency = z
  .object({ name: z.string(), kind: z.string(), file: z.string(), line: position })
  .passthrough();
const playset = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  loadOrder: z.string(),
  mods: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      position: z.union([z.number(), z.string()]),
      path: z.string().nullable(),
      registryId: z.string().nullable(),
      status: z.string(),
      archivePath: z.string().nullable(),
    })
  ),
  disabledDlcs: strings,
});
const data: Record<PxtkOperation, z.ZodType> = {
  playsets: z.object({
    settingsFile: z.string(),
    userDataPath: z.string(),
    databasePath: z.string(),
    loadSettingsFile: z.string(),
    presets: z.array(z.object({ id: z.string(), label: z.string(), args: strings })),
    playsets: z.array(playset),
  }),
  launch: z.object({
    mode: z.enum(["preview", "started"]),
    previewToken: hash.describe("Use with the same launch arguments and start=true."),
    executable: z.string(),
    cwd: z.string(),
    args: strings,
    steamAppId: z.number(),
    playset: playset.nullable(),
    loadSettings: z.object({
      file: z.string(),
      format: z.enum(["dlc", "content"]),
      changed: z.boolean(),
      beforeSha256: hash,
      afterSha256: hash,
      data: record,
    }),
    backupFile: z.string().nullable(),
    process: z
      .object({ pid: position, state: z.enum(["running", "exited"]), exitCode: z.number().int().nullable() })
      .nullable(),
    launcherSelectionChanged: z.literal(false),
    gameplayTested: z.literal(false),
  }),
  status: z.object({
    configFile: z.string().nullable(),
    issues: strings,
    index: record.nullable().optional(),
    indexed: z.literal(false).optional(),
    capabilities: record.optional(),
    tiger: record.optional(),
    nextSteps: strings.optional(),
  }),
  search: z.object({
    documentation: window(record),
    definitions: window(symbol),
    documentationSources: strings,
  }),
  inspect: z.union([
    z.object({ candidates: z.array(record), nextStep: z.string() }),
    z.object({
      documentation: window(record),
      definitions: window(
        z.object({
          name: z.string(),
          kind: z.string(),
          source: z
            .object({
              file: z.string(),
              line: position,
              contextStart: position,
              context: strings,
              sourceHash: hash,
              totalLines: count,
              truncated: z.boolean(),
              omittedBefore: z.boolean(),
              omittedAfter: z.boolean(),
              next: cursor.nullable(),
            })
            .passthrough(),
        })
      ),
      examples: window(record).optional(),
      templates: window(record).optional(),
    }),
  ]),
  read: z.object({
    file: z.string(),
    startLine: position,
    startColumn: position,
    endLine: position,
    endColumn: position,
    text: z.string(),
    context: strings,
    totalLines: count,
    sourceHash: hash,
    encoding: z.string(),
    truncated: z.boolean(),
    omittedBefore: z.boolean(),
    omittedAfter: z.boolean(),
    next: cursor.nullable(),
  }),
  impact: z.union([
    z.object({ name: z.string(), kinds: strings, nextStep: z.string() }),
    z.object({
      definition: dependency.nullable(),
      callers: window(dependency),
      references: window(record),
      dependencies: window(dependency),
      overrides: window(record),
      coverage: record,
    }),
  ]),
  conflicts: z.object({
    supported: z.boolean(),
    game: z.string(),
    inputOrder: z.literal("first-loaded-first"),
    inputs: z.array(
      z.object({
        id: z.string(),
        path: z.string(),
        name: z.string(),
        version: z.string().nullable(),
        replacePaths: window(z.string()),
        dependencies: window(z.string()),
      })
    ),
    sourceFingerprint: hash.nullable(),
    sourceCount: count,
    fileCount: count,
    conflicts: window(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.string(),
        state: z.string(),
        fingerprint: hash,
        explanation: z.string(),
        winner: z.string().nullable(),
        contributors: window(record),
        issues: window(z.string()),
      })
    ),
    issues: window(z.string()),
    coverage: record,
  }),
  rename: write.extend({
    edits: z.array(
      z.object({
        file: z.string(),
        edits: z.array(z.object({ start: count, end: count, newText: z.string() })),
      })
    ),
    coverage: record,
  }),
  edit: write.extend({
    edits: z.array(
      z.object({
        file: z.string(),
        edits: z.array(z.object({ start: count, end: count, newText: z.string() })),
      })
    ),
    coverage: record,
  }),
  import: write.extend({
    source: z.string(),
    destination: z.string(),
    kind: z.enum(["file", "directory"]),
    folders: strings,
  }),
  package: z
    .object({
      mode: z.enum(["preview", "written"]),
      previewToken: hash,
      destination: z.string(),
      included: window(z.object({ file: z.string(), bytes: count, sha256: hash })),
      excluded: window(z.object({ file: z.string(), reason: z.string() })),
      findings: window(record),
      totalFiles: count,
      totalBytes: count,
      ready: z.boolean(),
      changed: count,
      written: strings,
    })
    .passthrough(),
  migrate: z
    .object({
      action: z.enum(["catalog", "routes", "preview"]),
      mode: z.enum(["read", "preview"]),
      gameplayTested: z.literal(false),
      trustRequired: z.boolean().optional(),
      catalog: window(record).optional(),
      routes: window(record).optional(),
      versions: strings.optional(),
      issues: strings.optional(),
      blockedReasons: strings.optional(),
      prepared: z.boolean().optional(),
    })
    .passthrough(),
  validate: z.object({
    complete: z.boolean(),
    scope: z.object({
      structural: z.enum(["selected_files", "workspace"]),
      tiger: z.literal("workspace"),
      selected: strings,
    }),
    baselineApplied: z.boolean(),
    structural: z.object({ status: z.literal("complete"), files: count }),
    tiger: z.object({
      status: z.enum(["complete", "unavailable", "failed"]),
      version: z.string().optional(),
      reason: z.string().optional(),
      stderr: z.string().optional(),
      config: z.string().nullable().optional(),
      compatibility,
    }),
    compatibility,
    context: z.record(z.string(), z.string()),
    findings: window(findingSchema),
    newFindings: window(findingSchema),
    existingFindings: count,
    resolvedFindings: window(findingSchema),
    newErrors: count,
    gameplayTested: z.literal(false),
    baselineWritten: z.string().optional(),
  }),
  new: write,
  init: write,
  create: z.union([
    z.object({
      supported: z.array(
        z.object({ kind: z.string(), detail: z.string(), nameKind: z.string() }).passthrough()
      ),
    }),
    write,
  ]),
  loc: z.union([
    write,
    z.object({
      key: z.string(),
      language: z.string(),
      entries: z.array(record),
      total: count,
      truncated: z.boolean(),
      found: z.boolean(),
    }),
    z
      .object({
        language: z.string(),
        missing: window(z.unknown()),
        orphaned: window(z.unknown()),
        untranslated: window(z.unknown()),
        issues: count,
        coverage: z.string(),
      })
      .passthrough(),
  ]),
  logs: z.union([
    write,
    z.object({ checkpoint: record, pendingBytes: count }),
    z.object({
      file: z.string(),
      checkpoint: record,
      resetReason: z.string().nullable(),
      pendingBytes: count,
      entries: window(record),
      occurrences: count,
      coverage: z.string(),
    }),
  ]),
  format: write,
  image: z.object({ images: window(record), skipped: window(z.unknown()), notes: strings }).passthrough(),
};

/** Error envelopes lack operation/data. Successful tool data follows the operation's schema. */
export function responseSchema(operation: PxtkOperation) {
  return z
    .object({
      schemaVersion: z.literal(1),
      status: z.enum(["ok", "not_found", "ambiguous", "incomplete", "error"]),
      operation: z.literal(operation).optional(),
      sources: sources.optional(),
      warnings: strings.optional(),
      data: data[operation].optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .superRefine((result, ctx) => {
      if (result.status === "error") {
        if (!result.error) ctx.addIssue({ code: "custom", message: "Error results require error details." });
      } else if (
        result.operation === undefined ||
        !result.sources ||
        !result.warnings ||
        result.data === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Operation results require operation, sources, warnings and data.",
        });
      }
    });
}
