/**
 * Exercise the bundled CLI against the configured CK3 install and Tiger.
 * All generated content stays in .local/testing; game files are read-only.
 * Build with esbuild to dist/test-pxtk-real.cjs, then run that file.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { requireDevPath, devPath } from "./devPaths";
import { digest } from "../src/config";
import type { PxtkResult } from "../src/contract";
import { scaffoldDescriptor } from "@px-lsp/protocol/descriptorMod";
import type { MigrationManifest } from "@px-lsp/protocol/migration";

const exec = promisify(execFile);
/** Discover a small installed resource without assuming a particular game file. */
async function smallVanillaFile(game: string, mod: string) {
  const queue = [{ directory: game, depth: 0 }];
  const extensions = new Set([".txt", ".gui", ".asset", ".info", ".yml", ".gfx", ".sfx", ".shader", ".csv"]);
  let examined = 0;
  while (queue.length && examined < 5000) {
    const { directory, depth } = queue.shift()!;
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      if (examined >= 5000) break;
      examined++;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) queue.push({ directory: file, depth: depth + 1 });
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        const info = await fs.stat(file);
        if (info.size > 0 && info.size <= 64 * 1024) {
          const relative = path.relative(game, file).replace(/\\/g, "/");
          try {
            await fs.lstat(path.join(mod, relative));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return { file, relative, bytes: await fs.readFile(file) };
          }
        }
      }
      if (examined >= 5000) break;
    }
  }
  throw new Error("No ordinary installed resource under 64 KiB was found within the bounded import scan.");
}
async function main(): Promise<void> {
  const root = path.resolve(__dirname, "..");
  const game = requireDevPath("gamePath", "test-pxtk-real", "ck3");
  const tiger = requireDevPath("tigerPath", "test-pxtk-real", "ck3");
  const bundle = path.join(root, "dist/pxtk.cjs");
  const evidenceFile = path.join(game, "common/scripted_effects/00_intercourse_effects.txt");
  const evidence = await fs.readFile(evidenceFile);
  assert.match(
    evidence.toString("utf8"),
    /add_gold\s*=\s*1\b/,
    "The test effect must be backed by installed vanilla."
  );
  const testing = path.join(root, ".local/testing");
  await fs.mkdir(testing, { recursive: true });
  const mod = await fs.mkdtemp(path.join(testing, "pxtk real "));
  const artifacts = path.join(root, ".local/artifacts", path.basename(mod));
  await fs.mkdir(artifacts, { recursive: true });
  await fs.mkdir(path.join(mod, ".px-toolkit"));
  await fs.mkdir(path.join(mod, "common/scripted_effects"), { recursive: true });
  await fs.writeFile(path.join(mod, "descriptor.mod"), '\uFEFFname="pxtk real validation"\nversion="0.1"\n');
  const config = { game: "ck3", gamePath: game, tigerPath: tiger, logsPath: devPath("logsPath", "ck3") };
  await fs.writeFile(path.join(mod, ".px-toolkit/pxtk.json"), JSON.stringify(config, null, 2));
  const script = path.join(mod, "common/scripted_effects/pxtk_probe.txt");
  const clean = "\uFEFFpxtk_probe = { add_gold = 1 }\npxtk_caller = { pxtk_probe = yes }\n";
  await fs.writeFile(script, clean);
  const reports: Array<{ name: string; code: number; elapsedMs: number; status: string }> = [];
  async function run(name: string, args: string[], codes: number[] = [0]): Promise<PxtkResult> {
    const started = Date.now();
    let stdout: string,
      code = 0;
    try {
      ({ stdout } = await exec(process.execPath, [bundle, ...args, "--json"], {
        cwd: mod,
        // Explicit fixture configurations must not inherit another project's PX paths.
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PX_"))),
          PX_GAME_ID: "ck3",
          PX_CK3_MOD_PATH: mod,
        },
        timeout: 360_000,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      const failed = error as { stdout: string; code: number };
      if (!failed.stdout) throw error;
      stdout = failed.stdout;
      code = failed.code;
    }
    const result = JSON.parse(stdout) as PxtkResult;
    await fs.writeFile(path.join(artifacts, name + ".json"), JSON.stringify(result, null, 2));
    reports.push({ name, code, elapsedMs: Date.now() - started, status: result.status });
    console.log(`${name}: exit ${code}, ${result.status} (${Date.now() - started} ms)`);
    assert.ok(codes.includes(code), `${name}: expected exit ${codes}, got ${code}; see ${artifacts}`);
    return result;
  }
  const status = await run("status", ["status"]);
  assert.equal(status.sources.game, "ck3");
  const search = await run("search", ["search", "add_gold"]);
  assert.ok((search.data.documentation as { items: unknown[] }).items.length > 0);
  await run("inspect", ["inspect", "add_gold", "--kind", "effect"]);
  const impact = await run("impact", ["impact", "pxtk_probe", "--kind", "scripted_effect"]);
  assert.equal((impact.data.callers as { items: Array<{ name: string }> }).items[0]?.name, "pxtk_caller");
  const baseline = path.join(mod, ".px-toolkit/before.json");
  const initial = await run("baseline", ["validate", "--write-baseline", baseline], [0, 1, 2]);
  const compatibility = initial.data.compatibility as { status: string; evidence: string | null };
  const unsupported = compatibility.status === "unsupported";
  const gaps: string[] = [];
  if (unsupported) {
    assert.equal(initial.status, "incomplete");
    assert.equal(initial.data.complete, false);
    assert.ok(compatibility.evidence?.includes("PLEASE UPDATE"));
    assert.ok(initial.warnings.some((warning) => warning.includes("newer than its supported version")));
    await assert.rejects(fs.access(baseline));
    gaps.push(
      "Installed Tiger explicitly rejects this newer game version. Complete baseline comparison remains unverified against this installation."
    );
  } else assert.equal(initial.data.complete, true);
  const savedBaseline = unsupported ? null : digest(await fs.readFile(baseline));
  const comparison = unsupported ? [] : ["--baseline", baseline];
  await fs.writeFile(script, clean.replace("add_gold = 1", "pxtk_intentionally_invalid_effect = yes"));
  const invalid = await run("new-error", ["validate", ...comparison], [unsupported ? 2 : 1]);
  assert.ok(Number(invalid.data.newErrors) > 0);
  assert.equal(invalid.data.baselineApplied, !unsupported);
  await fs.writeFile(script, clean);
  const fixed = await run("fixed", ["validate", ...comparison], [unsupported ? 2 : 0]);
  assert.equal(fixed.data.newErrors, 0);
  if (!unsupported) {
    await run("refuse-overwrite", ["validate", "--write-baseline", baseline], [2]);
    assert.equal(digest(await fs.readFile(baseline)), savedBaseline);
    await run("config-mismatch", ["validate", "--language", "german", "--baseline", baseline], [2]);
  }
  await run("missing-validator", ["validate", "--tiger", path.join(mod, "missing-tiger.exe")], [2]);
  await run("create-event", ["create", "event", "pxtk_cli.1", "--prefix", "pxtk_cli", "--write"]);
  await run("edit-localization", ["loc", "set", "pxtk_cli_1_t", "--value", "CLI generated event", "--write"]);
  await run("format-event", ["format", "events/pxtk_cli_events.txt", "--write"]);
  const scaffold = await run("validate-scaffold", ["validate", ...comparison], [unsupported ? 2 : 0]);
  assert.equal(scaffold.data.newErrors, 0);
  const destination = await fs.mkdtemp(path.join(testing, "pxtk new real "));
  const newArgs = [
    "new",
    destination,
    "--name",
    "CLI new mod",
    "--game",
    "ck3",
    "--game-path",
    game,
    "--tiger",
    tiger,
  ];
  const preview = await run("new-mod-preview", newArgs);
  assert.deepEqual(await fs.readdir(destination), []);
  await run("new-mod-apply", [...newArgs, "--write", "--expect", String(preview.data.previewToken)]);
  const newValidation = await run(
    "validate-new-mod",
    ["validate", "--mod", destination],
    [unsupported ? 2 : 0]
  );
  assert.equal(newValidation.data.newErrors, 0);
  // New adapter exercises use CK3 metadata and tiny scratch sources. Only the
  // exact import below reads the installation; these checks do not certify gameplay.
  const workflowMod = await fs.mkdtemp(path.join(testing, "pxtk real workflows "));
  const workflowParent = await fs.mkdtemp(path.join(testing, "pxtk real workflow parent "));
  for (const [folder, name] of [
    [workflowMod, "pxtk real workflows"],
    [workflowParent, "pxtk real workflow parent"],
  ]) {
    await fs.mkdir(path.join(folder, "common/scripted_effects"), { recursive: true });
    await fs.writeFile(path.join(folder, "descriptor.mod"), "\uFEFF" + scaffoldDescriptor(name, "*"));
  }
  await fs.mkdir(path.join(workflowMod, ".px-toolkit"));
  const workflowConfig = path.join(workflowMod, ".px-toolkit/pxtk.json");
  await fs.writeFile(
    workflowConfig,
    JSON.stringify({
      game: "ck3",
      mod: ".",
      gamePath: null,
      tigerPath: null,
      logsPath: null,
      parents: [workflowParent],
    })
  );
  const runWorkflow = (name: string, args: string[], codes: number[] = [0]) =>
    run(name, [...args, "--config", workflowConfig, "--mod", workflowMod], codes);
  const refactorRelative = "common/scripted_effects/pxtk_refactor.txt";
  const refactorFile = path.join(workflowMod, refactorRelative);
  const refactorBefore =
    "\uFEFF# Preserve this heading\npxtk_rename_probe = {\n\tadd_gold = 1 # Preserve this property comment\n}\n\npxtk_rename_caller = { pxtk_rename_probe = yes }\n# Preserve this ending\n";
  await fs.writeFile(refactorFile, refactorBefore);
  const renameArgs = [
    "rename",
    "--file",
    refactorRelative,
    "--line",
    "2",
    "--column",
    "1",
    "--to",
    "pxtk_renamed_probe",
  ];
  const renamePreview = await runWorkflow("rename-preview", renameArgs);
  assert.equal(await fs.readFile(refactorFile, "utf8"), refactorBefore);
  const renamed = refactorBefore.replaceAll("pxtk_rename_probe", "pxtk_renamed_probe");
  await runWorkflow("rename-apply", [
    ...renameArgs,
    "--write",
    "--expect",
    String(renamePreview.data.previewToken),
  ]);
  assert.equal(
    await fs.readFile(refactorFile, "utf8"),
    renamed,
    "Rename must update declaration and caller while preserving neighboring bytes."
  );
  const operationsFile = path.join(artifacts, "edit-operations.json");
  await fs.writeFile(
    operationsFile,
    JSON.stringify([
      { op: "setProperties", name: "pxtk_renamed_probe", properties: [{ key: "add_gold", value: "2" }] },
    ])
  );
  const editArgs = ["edit", "--file", refactorRelative, "--operations", operationsFile];
  const editPreview = await runWorkflow("edit-preview", editArgs);
  assert.equal(await fs.readFile(refactorFile, "utf8"), renamed);
  await runWorkflow("edit-apply", [
    ...editArgs,
    "--write",
    "--expect",
    String(editPreview.data.previewToken),
  ]);
  const edited = renamed.replace("add_gold = 1", "add_gold = 2");
  assert.equal(
    await fs.readFile(refactorFile, "utf8"),
    edited,
    "Precise edit must retain comments, caller and file structure."
  );

  const english = path.join(workflowMod, "localization/english/pxtk_sync_l_english.yml");
  const german = path.join(workflowMod, "localization/german/pxtk_sync_l_german.yml");
  await fs.mkdir(path.dirname(english), { recursive: true });
  await fs.mkdir(path.dirname(german), { recursive: true });
  const englishBefore =
    '\uFEFFl_english:\r\n pxtk_sync_existing:0 "Source title"\r\n pxtk_sync_missing:4 "Source description"\r\n';
  const germanBefore =
    '\uFEFFl_german:\r\n # Preserve this translator comment\r\n pxtk_sync_existing:9 "Translated title" # retain\r\n\r\n';
  await fs.writeFile(english, englishBefore);
  await fs.writeFile(german, germanBefore);
  const syncArgs = ["loc", "sync", "--source-language", "english", "--language", "german"];
  const syncPreview = await runWorkflow("sync-preview", syncArgs);
  assert.equal(syncPreview.data.addedKeys, 1);
  assert.equal(await fs.readFile(german, "utf8"), germanBefore);
  await runWorkflow("sync-apply", [
    ...syncArgs,
    "--write",
    "--expect",
    String(syncPreview.data.previewToken),
  ]);
  const synced = await fs.readFile(german, "utf8");
  assert.ok(synced.startsWith(germanBefore));
  assert.ok(synced.includes('pxtk_sync_missing:4 "" # english: Source description\r\n'));
  assert.equal(await fs.readFile(english, "utf8"), englishBefore);
  const synchronized = await runWorkflow("sync-current", syncArgs);
  assert.equal(synchronized.data.changed, 0);
  const conflictRelative = "common/scripted_effects/pxtk_order.txt";
  const parentConflict = path.join(workflowParent, conflictRelative);
  const modConflict = path.join(workflowMod, conflictRelative);
  const parentBefore = "\uFEFFpxtk_order_probe = { add_gold = 1 }\n";
  const modBefore = "\uFEFFpxtk_order_probe = { add_gold = 2 }\n";
  await fs.writeFile(parentConflict, parentBefore);
  await fs.writeFile(modConflict, modBefore);
  const forward = await runWorkflow(
    "conflicts-forward",
    ["conflicts", "--input", workflowParent, "--input", workflowMod],
    [1]
  );
  const reverse = await runWorkflow(
    "conflicts-reverse",
    ["conflicts", "--input", workflowMod, "--input", workflowParent],
    [1]
  );
  const conflictWinner = (report: PxtkResult) => {
    const entries = report.data.conflicts as {
      items: Array<{
        name: string;
        winner: string;
        contributors: { items: Array<{ id: string; sourceName: string }> };
      }>;
    };
    const entry = entries.items.find((item) => item.name === "pxtk_order_probe");
    assert.ok(entry, "The shared definition must appear in the conflict report.");
    return entry.contributors.items.find((contributor) => contributor.id === entry.winner)?.sourceName;
  };
  assert.equal(conflictWinner(forward), "pxtk real workflows");
  assert.equal(conflictWinner(reverse), "pxtk real workflow parent");
  assert.equal(await fs.readFile(parentConflict, "utf8"), parentBefore);
  assert.equal(await fs.readFile(modConflict, "utf8"), modBefore);
  await runWorkflow(
    "rename-refuse-parent",
    ["rename", "--file", parentConflict, "--line", "1", "--column", "1", "--to", "pxtk_forbidden"],
    [2]
  );

  const imported = await smallVanillaFile(await fs.realpath(game), workflowMod);
  const importedDestination = path.join(workflowMod, imported.relative);
  const importArgs = ["import", "--source", imported.relative, "--mod", workflowMod];
  const importPreview = await run("import-preview", importArgs);
  await assert.rejects(fs.access(importedDestination));
  await run("import-apply", [...importArgs, "--write", "--expect", String(importPreview.data.previewToken)]);
  assert.equal(digest(await fs.readFile(importedDestination)), digest(imported.bytes));
  await run(
    "import-refuse-existing",
    [...importArgs, "--write", "--expect", String(importPreview.data.previewToken)],
    [2]
  );
  assert.equal(digest(await fs.readFile(imported.file)), digest(imported.bytes));
  assert.equal(digest(await fs.readFile(importedDestination)), digest(imported.bytes));

  await fs.mkdir(path.join(workflowMod, "notes"));
  await fs.writeFile(path.join(workflowMod, "notes/private.txt"), "Scratch author notes.\n");
  await fs.writeFile(path.join(workflowMod, ".pxignore"), "notes/\n");
  const release = path.join(artifacts, "workflow-release");
  const packageArgs = ["package", "--output", release, "--limit", "200"];
  const packagePreview = await runWorkflow("package-preview", packageArgs);
  assert.equal(packagePreview.data.ready, true);
  await assert.rejects(fs.access(release));
  await runWorkflow("package-apply", [
    ...packageArgs,
    "--write",
    "--expect",
    String(packagePreview.data.previewToken),
  ]);
  const packageFiles = packagePreview.data.included as {
    items: Array<{ file: string; sha256: string }>;
    truncated: boolean;
  };
  assert.equal(packageFiles.truncated, false);
  assert.ok(packageFiles.items.some((file) => file.file === "descriptor.mod"));
  for (const file of packageFiles.items)
    assert.equal(digest(await fs.readFile(path.join(release, file.file))), file.sha256);
  await assert.rejects(fs.access(path.join(release, ".px-toolkit")));
  await assert.rejects(fs.access(path.join(release, "notes/private.txt")));
  await runWorkflow(
    "package-refuse-existing",
    [...packageArgs, "--write", "--expect", String(packagePreview.data.previewToken)],
    [2]
  );

  const catalog = await runWorkflow("migration-catalog", ["migrate", "catalog", "--limit", "200"]);
  const catalogData = catalog.data.catalog as { items: MigrationManifest[]; truncated: boolean };
  assert.ok(catalogData.items.length > 0);
  assert.equal(catalogData.truncated, false);
  const transition =
    catalogData.items.find((entry) => entry.toVersion === status.sources.gameVersion) ?? catalogData.items[0];
  const routes = await runWorkflow("migration-routes", [
    "migrate",
    "routes",
    "--from",
    transition.fromVersion,
    "--to",
    transition.toVersion,
    "--limit",
    "200",
  ]);
  assert.ok((routes.data.routes as { total: number }).total > 0);
  assert.equal(catalog.data.prepared, false);
  assert.equal(routes.data.prepared, false);
  gaps.push(
    "No exact old-build game corpus was supplied. Migration catalog and exact-build routes were exercised; full compatible CK3 recipe preparation remains unverified. No migration was applied."
  );
  const workflowEvidence = {
    mod: workflowMod,
    parent: workflowParent,
    scope: {
      scratchOnly: ["loc sync", "rename", "edit", "conflicts", "package", "migration catalog/routes"],
      scratchGamePath: null,
      installedGameRead:
        "One discovered resource was imported byte-for-byte; the installed source remained unchanged.",
      gameplayTested: false,
    },
    rename: { changedFiles: renamePreview.data.changed, declarationAndCallerPreserved: true },
    edit: { changedFiles: editPreview.data.changed, neighboringSourcePreserved: true },
    sync: { addedKeys: syncPreview.data.addedKeys, existingTranslationPreserved: true },
    conflicts: {
      forwardWinner: conflictWinner(forward),
      reverseWinner: conflictWinner(reverse),
      sourcesPreserved: true,
    },
    imported: { file: imported.relative, bytes: imported.bytes.length, sha256: digest(imported.bytes) },
    package: {
      destination: release,
      verifiedFiles: packageFiles.items.length,
      toolkitConfigAndNotesExcluded: true,
    },
    migrations: {
      catalogEntries: catalogData.items.length,
      fromBuild: transition.fromVersion,
      toBuild: transition.toVersion,
      routes: (routes.data.routes as { total: number }).total,
      prepared: false,
    },
  };
  assert.equal(await fs.readFile(refactorFile, "utf8"), edited);
  assert.equal(await fs.readFile(parentConflict, "utf8"), parentBefore);
  assert.equal(digest(await fs.readFile(imported.file)), digest(imported.bytes));
  assert.equal(digest(await fs.readFile(evidenceFile)), digest(evidence));
  assert.equal(await fs.readFile(script, "utf8"), clean);
  await fs.writeFile(
    path.join(artifacts, "summary.json"),
    JSON.stringify(
      {
        gameVersion: status.sources.gameVersion,
        mod,
        evidenceFile,
        evidenceSha256: digest(evidence),
        compatibility,
        gaps,
        workflowEvidence,
        reports,
      },
      null,
      2
    )
  );
  for (const gap of gaps) console.log(`Coverage gap: ${gap}`);
  console.log(
    `Passed real CK3 exercise${gaps.length ? " with the coverage gaps above" : ""}. Reports: ${artifacts}`
  );
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
