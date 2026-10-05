// Test the actual tarball without a workspace node_modules tree.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tarball = process.argv[2];
if (!tarball) throw new Error("Usage: node scripts/test-pxtk-package.mjs <cli.tgz>");
const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".local/testing"), { recursive: true });
const scratch = await mkdtemp(path.join(root, ".local/testing/pxtk package ü "));
// Windows' system tar loses non-ASCII command-line paths. The process cwd is
// set through the native Unicode API, so keep tar's own arguments relative.
await copyFile(path.resolve(tarball), path.join(scratch, "payload.tgz"));
execFileSync("tar", ["-xzf", "payload.tgz"], { cwd: scratch });
const pkg = path.join(scratch, "package");
const manifest = JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8"));
assert.equal(manifest.bin.pxtk, "dist/pxtk.cjs");
assert.deepEqual(
  Object.keys(manifest.dependencies ?? {}),
  ["sharp"],
  "Only the native image codec is installed separately."
);
for (const file of [
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "dist/lsp/server.js",
  "dist/migrations/worker.cjs",
  "dist/licenses/dependencies.json",
  "dist/data/ck3/freqs.json",
  "dist/data/vic3/freqs.json",
  "dist/data/eu5/skeletons.json",
  "plugins/paradox-toolkit/.codex-plugin/plugin.json",
  "plugins/paradox-toolkit/.claude-plugin/plugin.json",
  "plugins/paradox-toolkit/.mcp.json",
  "plugins/paradox-toolkit/skills/paradox-toolkit/SKILL.md",
])
  await access(path.join(pkg, file));
const mod = path.join(scratch, "mod");
await mkdir(path.join(mod, ".px-toolkit"), { recursive: true });
await mkdir(path.join(mod, "common/scripted_effects"), { recursive: true });
await writeFile(path.join(mod, "descriptor.mod"), '\uFEFFname="Packed CLI test"\n');
await writeFile(
  path.join(mod, ".px-toolkit/pxtk.json"),
  JSON.stringify({ game: "ck3", gamePath: null, logsPath: null, tigerPath: null })
);
await writeFile(path.join(mod, "common/scripted_effects/probe.txt"), "\uFEFFpxtk_packed_probe = {}\n");
await writeFile(
  path.join(scratch, "package.json"),
  JSON.stringify({ private: true, dependencies: { "@px-lsp/cli": "file:./payload.tgz" } })
);
await writeFile(path.join(scratch, "pnpm-workspace.yaml"), "packages: []\n");
// Test a consumer install. A frozen workspace install need not cache registry
// metadata for all native optional packages, so offline resolution can omit them.
execSync("pnpm install --ignore-scripts", { cwd: scratch, stdio: "inherit", windowsHide: true });
const installedVersion = JSON.parse(
  execSync("pnpm exec pxtk --version --json", {
    cwd: scratch,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  })
);
assert.deepEqual(installedVersion, { schemaVersion: 1, version: manifest.version });
const command = path.join(scratch, "node_modules/@px-lsp/cli", manifest.bin.pxtk);
const result = JSON.parse(
  execFileSync(
    process.execPath,
    [command, "inspect", "pxtk_packed_probe", "--kind", "scripted_effect", "--json"],
    {
      cwd: mod,
      encoding: "utf8",
      timeout: 60_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PX_"))),
    }
  )
);
assert.equal(result.status, "ok");
assert.equal(result.data.definitions.items[0].name, "pxtk_packed_probe");
assert.equal(result.sources.documentation, "bundled");
const installedOptions = {
  cwd: mod,
  encoding: "utf8",
  timeout: 60_000,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PX_"))),
};
const source = result.data.definitions.items[0].source;
const page = JSON.parse(
  execFileSync(
    process.execPath,
    [command, "read", source.file, "--source-hash", source.sourceHash, "--json"],
    installedOptions
  )
);
assert.equal(page.data.text, "pxtk_packed_probe = {}\n");
assert.equal(page.data.next, null);
const newArgs = [command, "new", path.join(scratch, "new mod"), "--name", "Packed new mod", "--json"];
const newPreview = JSON.parse(execFileSync(process.execPath, newArgs, installedOptions));
assert.equal(newPreview.data.mode, "preview");
await assert.rejects(access(path.join(scratch, "new mod")));
const newWritten = JSON.parse(
  execFileSync(
    process.execPath,
    [...newArgs, "--write", "--expect", newPreview.data.previewToken],
    installedOptions
  )
);
assert.equal(newWritten.data.mode, "written");
assert.equal(
  (await readFile(path.join(scratch, "new mod/descriptor.mod"))).subarray(0, 3).toString("hex"),
  "efbbbf"
);
const invalid = spawnSync(process.execPath, [command, "search", "pxtk", "--game", "unknown", "--json"], {
  cwd: mod,
  encoding: "utf8",
  timeout: 60_000,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PX_"))),
});
if (invalid.error) throw invalid.error;
assert.equal(invalid.status, 2);
assert.equal(invalid.stderr, "");
const invalidResult = JSON.parse(invalid.stdout);
assert.equal(invalidResult.status, "error");
assert.equal(invalidResult.error.code, "game_required");
const prepared = JSON.parse(
  execFileSync(
    process.execPath,
    [command, "create", "scripted_effect", "packed_effect", "--prefix", "packed", "--write", "--json"],
    {
      cwd: mod,
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PX_"))),
    }
  )
);
assert.equal(prepared.data.mode, "written");
await writeFile(
  path.join(mod, "pixel.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
    "base64"
  )
);
const image = JSON.parse(
  execFileSync(process.execPath, [command, "image", "inspect", "pixel.png", "--json"], {
    cwd: mod,
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PX_"))),
  })
);
assert.equal(image.data.images.items[0].width, 1);
const gamePath = path.join(scratch, "install/game");
const launcherPath = path.join(scratch, "install/launcher");
const userDataPath = path.join(scratch, "user-data");
for (const directory of [gamePath, launcherPath, userDataPath]) await mkdir(directory, { recursive: true });
await writeFile(
  path.join(launcherPath, "launcher-settings.json"),
  JSON.stringify({
    gameId: "ck3",
    formatVersion: 0,
    exePath: process.execPath,
    exeArgs: [],
    gameDataPath: userDataPath,
  })
);
const loadFile = path.join(userDataPath, "dlc_load.json");
const loadBytes = Buffer.from('{"enabled_mods":[],"disabled_dlcs":[],"preserved":true}');
await writeFile(loadFile, loadBytes);
const databaseFile = path.join(userDataPath, "launcher-v2.sqlite");
const database = new DatabaseSync(databaseFile);
database.exec(`CREATE TABLE playsets(id TEXT,name TEXT,isActive INTEGER,isRemoved INTEGER,loadOrder TEXT);
CREATE TABLE playsets_mods(playsetId TEXT,modId TEXT,enabled INTEGER,position INTEGER);
CREATE TABLE mods(id TEXT,name TEXT,displayName TEXT,gameRegistryId TEXT,dirPath TEXT,archivePath TEXT,status TEXT);
CREATE TABLE playsets_dlcs(playsetId TEXT,dlcId TEXT,enabled INTEGER);
INSERT INTO playsets VALUES('packed-playset','Packed playset',1,0,'custom');`);
database.close();
const databaseBytes = await readFile(databaseFile);
const launcherArgs = ["--game-path", gamePath, "--user-data-path", userDataPath];
const playsets = JSON.parse(
  execFileSync(process.execPath, [command, "playsets", ...launcherArgs, "--json"], installedOptions)
);
assert.equal(playsets.data.playsets[0].id, "packed-playset");
const preview = JSON.parse(
  execFileSync(
    process.execPath,
    [command, "launch", ...launcherArgs, "--playset", "packed-playset", "--arg=-debug_mode", "--json"],
    installedOptions
  )
);
assert.equal(preview.data.mode, "preview");
assert.deepEqual(preview.data.args, ["-debug_mode"]);
assert.equal(preview.data.process, null);
assert.deepEqual(await readFile(loadFile), loadBytes);
assert.deepEqual(await readFile(databaseFile), databaseBytes);
const client = new Client({ name: "packed-cli-test", version: "1" });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [command, "mcp", ...launcherArgs],
      cwd: mod,
      env: installedOptions.env,
      stderr: "pipe",
    })
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 21);
  assert.ok(tools.tools.every((tool) => tool.outputSchema?.type === "object"));
  assert.ok(tools.tools.some((tool) => tool.name === "pxtk_playsets"));
  const launch = tools.tools.find((tool) => tool.name === "pxtk_launch");
  assert.ok(launch);
  assert.deepEqual(launch.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  const response = await client.callTool({ name: "pxtk_read", arguments: source.continuation });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.data.text, "pxtk_packed_probe = {}\n");
  const launchPreview = await client.callTool({
    name: "pxtk_launch",
    arguments: { playset: "packed-playset", args: ["-debug_mode"] },
  });
  assert.equal(launchPreview.isError, undefined);
  assert.equal(launchPreview.structuredContent.data.previewToken, preview.data.previewToken);
  assert.deepEqual(await readFile(loadFile), loadBytes);
} finally {
  await client.close();
}

// Exercise new workflows from the installed package and its bundled worker.
const installedRun = (...args) =>
  JSON.parse(execFileSync(process.execPath, [command, ...args, "--json"], installedOptions));
await writeFile(
  path.join(mod, "descriptor.mod"),
  '\uFEFFname="Packed CLI test"\nversion="1.0"\nsupported_version="*"\ntags={ "Gameplay" }\n'
);
await mkdir(path.join(mod, "localization/english"), { recursive: true });
await writeFile(
  path.join(mod, "localization/english/packed_l_english.yml"),
  '\uFEFFl_english:\n packed_text:0 "Packed source"\n'
);
const syncArgs = ["loc", "sync", "--source-language", "english", "--language", "german"];
const syncPreview = installedRun(...syncArgs);
assert.equal(syncPreview.data.mode, "preview");
await assert.rejects(access(path.join(mod, "localization/german/packed_l_german.yml")));
assert.equal(
  installedRun(...syncArgs, "--write", "--expect", syncPreview.data.previewToken).data.mode,
  "written"
);
assert.match(
  await readFile(path.join(mod, "localization/german/packed_l_german.yml"), "utf8"),
  /packed_text:0 ""/
);

const renameArgs = [
  "rename",
  "--file",
  "common/scripted_effects/probe.txt",
  "--line",
  "1",
  "--column",
  "1",
  "--to",
  "pxtk_packed_renamed",
];
const renamePreview = installedRun(...renameArgs);
assert.equal(renamePreview.data.mode, "preview");
assert.equal(
  installedRun(...renameArgs, "--write", "--expect", renamePreview.data.previewToken).data.mode,
  "written"
);
assert.match(
  await readFile(path.join(mod, "common/scripted_effects/probe.txt"), "utf8"),
  /pxtk_packed_renamed =/
);
const operationsFile = path.join(scratch, "edits.json");
await writeFile(
  operationsFile,
  JSON.stringify([
    { op: "setProperties", name: "pxtk_packed_renamed", properties: [{ key: "add_gold", value: "3" }] },
  ])
);
const editArgs = ["edit", "--file", "common/scripted_effects/probe.txt", "--operations", operationsFile];
const editPreview = installedRun(...editArgs);
assert.equal(
  installedRun(...editArgs, "--write", "--expect", editPreview.data.previewToken).data.mode,
  "written"
);
assert.match(await readFile(path.join(mod, "common/scripted_effects/probe.txt"), "utf8"), /add_gold = 3/);

const parentMod = path.join(scratch, "parent-mod");
await mkdir(path.join(parentMod, "common/scripted_effects"), { recursive: true });
await writeFile(path.join(parentMod, "descriptor.mod"), '\uFEFFname="Packed parent"\n');
await writeFile(
  path.join(parentMod, "common/scripted_effects/conflict.txt"),
  "\uFEFFpacked_conflict = { add_gold = 1 }\n"
);
await writeFile(
  path.join(mod, "common/scripted_effects/conflict.txt"),
  "\uFEFFpacked_conflict = { add_gold = 2 }\n"
);
const conflictProcess = spawnSync(
  process.execPath,
  [command, "conflicts", "--input", parentMod, "--input", mod, "--json"],
  installedOptions
);
assert.equal(conflictProcess.status, 1, "An installed conflict report with findings must exit 1.");
const conflicts = JSON.parse(conflictProcess.stdout);
assert.equal(conflicts.status, "ok");
assert.equal(conflicts.data.sourceCount, 2);
assert.equal(
  conflicts.data.conflicts.items.find((entry) => entry.name === "packed_conflict").contributors.total,
  2
);

await mkdir(path.join(gamePath, "common/scripted_effects"), { recursive: true });
const vanillaFile = path.join(gamePath, "common/scripted_effects/imported.txt");
await writeFile(vanillaFile, "\uFEFFpacked_vanilla = { }\n");
const importArgs = ["import", "--source", "common/scripted_effects/imported.txt", "--game-path", gamePath];
const importPreview = installedRun(...importArgs);
assert.equal(importPreview.data.mode, "preview");
assert.equal(
  installedRun(...importArgs, "--write", "--expect", importPreview.data.previewToken).data.mode,
  "written"
);
assert.deepEqual(
  await readFile(path.join(mod, "common/scripted_effects/imported.txt")),
  await readFile(vanillaFile)
);

const migrationCatalog = installedRun("migrate", "catalog");
assert.ok(migrationCatalog.data.catalog.items.length);
const firstRecipe = migrationCatalog.data.catalog.items[0];
assert.ok(
  installedRun("migrate", "routes", "--from", firstRecipe.fromVersion, "--to", firstRecipe.toVersion).data
    .routes.items.length
);
const recipeFile = path.join(mod, ".px-toolkit/fixture.cjs");
const recipeCode = `module.exports={manifest:{id:'fixture.setting',revision:'1',sdkVersion:1,gameId:'ck3',fromVersion:'1.0.0',toVersion:'1.1.0',kind:'recipe',detection:'script',requirement:'required',title:'Fixture',description:'Test fixture',guidance:'Fixture only',limitations:['No runtime verification'],dependsOn:[],evidence:['Synthetic fixture'],inputs:[{root:'mod',path:'common'}]},inspect(){return {applicability:'applicable',findings:[],questions:[],coverage:['Fixture only']};},prepare(ctx){const text=ctx.readText('mod','common/test.txt');const start=text.indexOf('yes');return {groups:[{id:'setting',title:'Setting',dependsOn:[],changes:[{kind:'text',path:'common/test.txt',edits:[{start,end:start+3,text:'no'}]}]}],checks:[],unresolved:[]};}};`;
await writeFile(recipeFile, recipeCode);
await writeFile(path.join(mod, "common/test.txt"), "\uFEFFsetting = yes\n");
const migration = installedRun(
  "migrate",
  "preview",
  "--recipe",
  "fixture.setting",
  "--recipe-file",
  recipeFile,
  "--trust",
  createHash("sha256").update(recipeCode).digest("hex")
);
assert.equal(migration.data.prepared, true);
assert.equal(migration.data.plan.files.items[0].after.content, "\uFEFFsetting = no\n");
assert.equal(await readFile(path.join(mod, "common/test.txt"), "utf8"), "\uFEFFsetting = yes\n");

await mkdir(path.join(mod, ".vscode"));
await writeFile(path.join(mod, ".vscode/settings.json"), "{}");
const release = path.join(scratch, "release");
const packageArgs = ["package", "--output", release];
const packagePreview = installedRun(...packageArgs);
assert.equal(packagePreview.data.ready, true);
await assert.rejects(access(release));
assert.equal(
  installedRun(...packageArgs, "--write", "--expect", packagePreview.data.previewToken).data.mode,
  "written"
);
assert.deepEqual(
  await readFile(path.join(release, "descriptor.mod")),
  await readFile(path.join(mod, "descriptor.mod"))
);
await assert.rejects(access(path.join(release, ".vscode")));
await assert.rejects(access(path.join(release, ".px-toolkit")));
console.log(
  `Packed pxtk ${manifest.version}: executable, LSP, all games' data, licenses and plugin verified in ${scratch}`
);
