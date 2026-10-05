// Test the actual tarball without a workspace node_modules tree.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
execSync("pnpm install --offline --ignore-scripts", { cwd: scratch, stdio: "pipe", windowsHide: true });
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
  assert.equal(tools.tools.length, 15);
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
console.log(
  `Packed pxtk ${manifest.version}: executable, LSP, all games' data, licenses and plugin verified in ${scratch}`
);
