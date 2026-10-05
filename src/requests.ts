import { z } from "zod";
import type { PxtkRequest, PxtkOperation } from "./contract";
import { ToolError } from "./errors";

const limit = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Maximum returned matches or findings (default 20). Check each list's total and truncated fields."
  );
const text = z.string().min(1).describe("Non-empty text.");
const files = z
  .array(text)
  .min(1)
  .max(200)
  .describe("Saved file paths, absolute or relative to the configured mod; 1 to 200 entries.");
const write = {
  write: z
    .boolean()
    .optional()
    .describe("Apply these authorized changes. Omit or false to preview without writing."),
  expect: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe(
      "previewToken from the same operation and arguments. Use with write=true; changed inputs reject the apply."
    ),
};
export const definitions: Array<{
  operation: PxtkOperation;
  description: string;
  schema: z.ZodRawShape;
  writes?: boolean;
  openWorld?: boolean;
}> = [
  {
    operation: "playsets",
    description:
      "List saved Paradox Launcher playsets and ordered mods for the selected game. Reads the launcher database without changing its active selection; no editable mod is required.",
    schema: {},
  },
  {
    operation: "launch",
    description:
      "Preview the exact game executable, arguments and selected launcher playset. Omit playset to keep current load settings. Start requires start=true and the preview token; checks for a running game before changing load settings. Process startup is not proof that a mod loaded.",
    schema: {
      playset: text
        .optional()
        .describe(
          "Exact saved launcher playset ID or unique name. Omit to preserve the current engine load settings."
        ),
      preset: text
        .optional()
        .describe("Optional preset ID from the selected game profile, listed by pxtk_playsets."),
      args: z
        .array(
          z
            .string()
            .min(1)
            .max(4096)
            .refine((arg) => !arg.includes("\0"), "Arguments cannot contain NUL.")
        )
        .max(100)
        .optional()
        .describe(
          "Extra game arguments, each array item is one exact argument. Never pass a shell command; quoting is not needed inside an item."
        ),
      start: z
        .boolean()
        .optional()
        .describe(
          "Start the game after reviewing the preview. Default false leaves all files and processes unchanged."
        ),
      expect: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe(
          "previewToken from the same launch request. Required with start=true; changed inputs reject startup."
        ),
    },
    writes: true,
    openWorld: true,
  },
  {
    operation: "status",
    description: "Report selected game, mod, loaded documentation and validator availability.",
    schema: {},
  },
  {
    operation: "search",
    description:
      "Search documented identifiers and indexed definitions with bounded matches and source provenance.",
    schema: {
      query: text.describe("Identifier or words to search for."),
      kind: text.optional().describe("Kind returned by search, such as effect or scripted_effect."),
      limit,
    },
  },
  {
    operation: "inspect",
    description:
      "Read exact identifier documentation and source. Optionally return sourced examples and measured templates.",
    schema: {
      name: text.describe("Exact identifier to inspect."),
      kind: text.optional().describe("Kind returned by search; required to resolve ambiguous names."),
      limit,
      examples: z.boolean().optional().describe("Include sourced example snippets."),
      templates: z.boolean().optional().describe("Include measured templates when available."),
    },
  },
  {
    operation: "read",
    description:
      "Read a bounded page of saved source from the mod, dependencies or game. Follow next with sourceHash for lossless continuation; changed sources reject stale continuation.",
    schema: {
      file: text.describe("Source file from inspect, or an absolute/mod-relative supported text file."),
      startLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("First line, 1-based (default 1). Use next.startLine to continue."),
      startColumn: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("First UTF-16 column, 1-based (default 1). Use next.startColumn when a line spans pages."),
      lineCount: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum lines in the page (default 100, maximum 200)."),
      maxChars: z
        .number()
        .int()
        .min(1)
        .max(64000)
        .optional()
        .describe("Maximum text characters in the page (default 16000)."),
      sourceHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe("SHA-256 returned by inspect/read. Rejects continuation after a saved edit."),
    },
  },
  {
    operation: "impact",
    description:
      "Find callers, dependencies and override candidates. Reports winner rules and reference coverage limits.",
    schema: {
      name: text.describe("Exact definition name whose dependencies and callers are needed."),
      kind: text.optional().describe("Definition kind returned by search."),
      limit,
    },
  },
  {
    operation: "conflicts",
    description:
      "Report conflicts, replace paths and dependency-order issues across an ordered mod set. Uses the shared game composition policy; never generates or writes a patch.",
    schema: {
      inputs: z
        .array(text)
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Mod folders in load order, first loaded first. Omit to use configured parents followed by the editable mod."
        ),
      limit,
    },
  },
  {
    operation: "rename",
    description:
      "Preview a symbol rename through the shared language server. Positions are 1-based UTF-16. Refuses edits outside the editable mod and requires the preview token to apply. Dynamic references can be missed.",
    schema: {
      file: text.describe("Saved source file inside the editable mod."),
      line: z.number().int().positive().describe("Symbol line, 1-based."),
      column: z.number().int().positive().describe("Symbol UTF-16 column, 1-based."),
      to: text.describe("New identifier."),
      ...write,
    },
    writes: true,
  },
  {
    operation: "edit",
    description:
      "Preview precise definition edits while preserving neighboring source and comments. Property values and block text are script source. A refused operation rejects the batch; applying requires the preview token.",
    schema: {
      file: text.describe("Saved script file inside the editable mod."),
      edits: z
        .array(
          z.discriminatedUnion("op", [
            z.strictObject({
              op: z.literal("setProperties"),
              name: text,
              properties: z
                .array(z.strictObject({ key: text, value: z.string().max(1_000_000).nullable() }))
                .min(1)
                .max(1000),
            }),
            z.strictObject({ op: z.literal("upsertBlock"), name: text, text: text.max(1_000_000) }),
          ])
        )
        .min(1)
        .max(200)
        .describe("Ordered shared definition operations: setProperties or upsertBlock."),
      ...write,
    },
    writes: true,
  },
  {
    operation: "import",
    description:
      "Preview copying one exact vanilla file into the same mod-relative path, or creating one directory path. Never recursively copies a directory or replaces existing content. Apply with the preview token.",
    schema: {
      source: text.optional().describe("Game-relative source file. Mutually exclusive with directory."),
      directory: text
        .optional()
        .describe(
          "Existing game-relative directory whose path to create in the mod. No child content is copied."
        ),
      ...write,
    },
    writes: true,
  },
  {
    operation: "package",
    description:
      "Preview a local mod release directory with file hashes, exclusions and metadata findings. Applies .pxignore policy. Explicit write with the preview token creates an absent output directory; does not upload to Steam.",
    schema: {
      output: text.describe(
        "New output directory outside the mod, game and dependencies, with an existing parent."
      ),
      limit,
      ...write,
    },
    writes: true,
  },
  {
    operation: "migrate",
    description:
      "Discover migration entries, query exact-build routes, or preview a recipe. Does not apply plans. Local recipe code requires its exact SHA-256 in trust and runs with host permissions, without a sandbox.",
    schema: {
      action: z
        .enum(["catalog", "routes", "preview"])
        .optional()
        .describe("catalog (default), routes, or preview."),
      recipe: text.optional().describe("Migration entry ID from the catalog."),
      recipeFile: text
        .optional()
        .describe(
          "Local recipe artifact. Without trust, only its hash and size are inspected; code is not executed."
        ),
      trust: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe(
          "Explicitly trusted SHA-256 of the local recipe artifact. Local code has host permissions."
        ),
      fromBuild: text.optional().describe("Exact source game build, as listed by the catalog."),
      toBuild: text.optional().describe("Exact target game build, as listed by the catalog."),
      sourceGamePath: text
        .optional()
        .describe("Explicit read-only source game-data directory for recipe evidence."),
      targetGamePath: text
        .optional()
        .describe("Read-only target game-data directory; defaults to configured gamePath."),
      answers: z
        .record(z.string(), z.union([z.string(), z.boolean()]))
        .optional()
        .describe("Answers keyed by recipe question ID."),
      limit,
    },
    writes: true,
    openWorld: true,
  },
  {
    operation: "validate",
    description:
      "Validate saved files. Optional files focus structural checks; Tiger still checks the whole mod. Missing validation is explicit.",
    schema: {
      files: files.optional(),
      baseline: text
        .optional()
        .describe("Existing JSON baseline, relative to the mod or absolute. Compare findings against it."),
      writeBaseline: text
        .optional()
        .describe(
          "Explicitly create a new JSON baseline after complete validation. Path is inside the mod in an existing folder. Never overwrites; mutually exclusive with baseline."
        ),
      limit,
    },
    writes: true,
  },
  {
    operation: "new",
    description:
      "Preview a new mod with profile-derived metadata, folders and pxtk configuration. Destination must be absent or empty. Apply with write and the preview token; launcher registration remains a separate step.",
    schema: {
      output: text.describe(
        "Destination directory, absolute or relative to the MCP process working directory."
      ),
      name: text.describe("Display name for the mod descriptor or metadata."),
      supportedVersion: text
        .optional()
        .describe(
          "Declared supported game version. If omitted, use the detected installed game version when available."
        ),
      ...write,
    },
    writes: true,
  },
  {
    operation: "init",
    description:
      "Preview toolkit configuration for an existing mod. Explicit write creates it without replacing existing configuration.",
    schema: { ...write },
    writes: true,
  },
  {
    operation: "create",
    description:
      "List supported content kinds or preview a game-derived scaffold and localization. Explicit write applies the preview; expect rejects stale inputs.",
    schema: {
      kind: text
        .optional()
        .describe("Scaffold kind from create's supported list. Omit to list available kinds."),
      name: text.optional().describe("Definition identifier, or prefix.number for an event."),
      prefix: text
        .optional()
        .describe("Lowercase identifier prefix used for output filenames and event namespaces."),
      language: z
        .string()
        .regex(/^[a-z_]+$/)
        .optional()
        .describe("Localization language name (default configured language)."),
      stage: text.optional().describe("Load-stage folder from the selected game's profile, when supported."),
      ...write,
    },
    writes: true,
  },
  {
    operation: "loc",
    description:
      "Get localization with sources, check language coverage, or preview a key update. Explicit write updates mod files and preserves unrelated content.",
    schema: {
      action: z
        .enum(["get", "set", "check", "sync"])
        .optional()
        .describe(
          "get reads a key, set previews an edit, check reports coverage (default), sync adds missing translation entries without changing translated values."
        ),
      sourceLanguage: z
        .string()
        .regex(/^[a-z_]+$/)
        .optional()
        .describe("Required source language for sync. Must differ from the target language."),
      name: text.optional().describe("Localization key for get/set."),
      value: z
        .string()
        .optional()
        .describe("Desired unescaped localized text for set; an empty string is allowed."),
      language: z
        .string()
        .regex(/^[a-z_]+$/)
        .optional()
        .describe("Localization language name (default configured language)."),
      file: text
        .optional()
        .describe("Explicit mod localization destination when key placement is ambiguous."),
      stage: text.optional().describe("Profile load-stage folder, when supported."),
      limit,
      ...write,
    },
    writes: true,
  },
  {
    operation: "logs",
    description:
      "Read and group game error records, retaining unparsed text. Checkpoint optionally creates a new JSON file; since detects log rotation.",
    schema: {
      action: z
        .enum(["read", "checkpoint"])
        .optional()
        .describe("Read errors (default) or prepare a checkpoint before a playtest."),
      file: text.optional().describe("Saved log path; defaults to the selected game's runtime error.log."),
      since: text.optional().describe("Previous checkpoint JSON path."),
      output: text.optional().describe("New checkpoint JSON destination inside the editable mod."),
      limit,
      ...write,
    },
    writes: true,
  },
  {
    operation: "format",
    description:
      "Preview conservative script/GUI indentation. Check reports changes; explicit write applies them. Saved files only.",
    schema: {
      files,
      check: z.boolean().optional().describe("Report whether indentation would change, without writing."),
      ...write,
    },
    writes: true,
  },
  {
    operation: "image",
    description:
      "Inspect or convert DDS/TGA/PNG/JPEG/WebP files or folders. Preview by default; write creates new mod outputs. Optional resize; DDS output has no mipmaps.",
    schema: {
      action: z
        .enum(["inspect", "convert"])
        .optional()
        .describe("Inspect image metadata (default) or preview conversion."),
      files,
      output: text
        .optional()
        .describe("New output file or batch directory inside the mod; existing files are never replaced."),
      format: z
        .enum(["png", "jpeg", "webp", "dds"])
        .optional()
        .describe("Required conversion output format."),
      dds: z
        .enum(["auto", "bc1", "bc3", "bgra8"])
        .optional()
        .describe("DDS encoding; auto chooses BC3 for alpha or BC1 for opaque pixels. One mip level."),
      width: z.number().int().min(1).max(16384).optional().describe("Requested pixel width."),
      height: z.number().int().min(1).max(16384).optional().describe("Requested pixel height."),
      fit: z
        .enum(["contain", "cover", "inside", "fill"])
        .optional()
        .describe("Resize fit (default contain)."),
      background: text
        .optional()
        .describe("Background color required when converting transparent pixels to JPEG."),
      limit,
      ...write,
    },
    writes: true,
  },
];
export function validateRequest(request: PxtkRequest): void {
  const definition = definitions.find((entry) => entry.operation === request.operation);
  if (!definition) throw new ToolError("unknown_command", "Unknown operation.");
  const args = Object.fromEntries(
    Object.entries(request).filter(([key, value]) => key !== "operation" && value !== undefined)
  );
  const parsed = z.object(definition.schema).strict().safeParse(args);
  if (!parsed.success) throw new ToolError("invalid_arguments", parsed.error.message);
  if (request.baseline && request.writeBaseline)
    throw new ToolError("invalid_arguments", "Choose baseline comparison or baseline creation.");
  const readOnly =
    (request.operation === "loc" && !["set", "sync"].includes(request.action ?? "check")) ||
    (request.operation === "image" && request.action !== "convert") ||
    (request.operation === "logs" && request.action !== "checkpoint") ||
    (request.operation === "create" && !request.kind);
  if (readOnly && (request.write || request.expect))
    throw new ToolError("invalid_arguments", "This action does not write files.");
  const guarded =
    ["rename", "edit", "import", "package"].includes(request.operation) ||
    (request.operation === "loc" && request.action === "sync");
  if (guarded && request.write && !request.expect)
    throw new ToolError(
      "preview_required",
      "Preview these changes first, then apply with write and the matching expect token."
    );
  if (request.operation === "import" && Boolean(request.source) === Boolean(request.directory))
    throw new ToolError("invalid_arguments", "Choose exactly one source file or directory path.");
  if (request.operation === "loc") {
    if (request.action === "sync") {
      if (!request.sourceLanguage || !request.language || request.sourceLanguage === request.language)
        throw new ToolError(
          "invalid_arguments",
          "sync requires different sourceLanguage and language values."
        );
      if ([request.name, request.value, request.stage, request.limit].some((value) => value !== undefined))
        throw new ToolError(
          "invalid_arguments",
          "sync accepts sourceLanguage, language, optional file, write and expect."
        );
    } else if (request.sourceLanguage !== undefined) {
      throw new ToolError("invalid_arguments", "sourceLanguage belongs to loc sync.");
    }
  }
}
