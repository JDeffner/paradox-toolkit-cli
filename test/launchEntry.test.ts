import { afterAll, beforeAll, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { gameMetas } from "@px-lsp/server/games/metaRegistry";
import { responseSchema } from "../src/responses";

const exec = promisify(execFile);
const bundle = path.resolve("dist/pxtk.cjs");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("PX_")
  )
);
const args = ["-debug_mode", "two words", "& | ; $(literal) %PATH%", 'a"quote'];
let root: string;
let executable: string;
let script: string;
let loadFile: string;
let databaseFile: string;
let settingsFile: string;
let resultFile: string;
let originalLoad: Buffer;
let originalDatabase: Buffer;
let originalSettings: Buffer;

interface Envelope {
  status: string;
  error?: { code: string };
  data: {
    mode: string;
    previewToken: string;
    args: string[];
    backupFile: string;
    process: { pid: number; state: string; exitCode: number };
  };
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const cliArgs = () => ["launch", "--playset", "Fixture playset", "--arg=-debug_mode"];

async function run(...arguments_: string[]) {
  try {
    const result = await exec(process.execPath, [bundle, "--json", ...arguments_], {
      cwd: root,
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, body: JSON.parse(result.stdout) as Envelope };
  } catch (error) {
    const result = error as { code: number; stdout: string };
    if (!result.stdout) throw error;
    return { code: result.code, body: JSON.parse(result.stdout) as Envelope };
  }
}

beforeAll(async () => {
  await fs.access(bundle);
  await fs.mkdir(".local/testing", { recursive: true });
  root = await fs.mkdtemp(path.resolve(".local/testing/pxtk-launch-entry-"));
  const gamePath = path.join(root, "install/game");
  const launcherPath = path.join(root, "install/launcher");
  const bin = path.join(root, "install/bin");
  const userDataPath = path.join(root, "user-data");
  const mod = path.join(root, "fixture-mod");
  for (const dir of [gamePath, launcherPath, bin, userDataPath, mod, path.join(root, ".px-toolkit")]) {
    await fs.mkdir(dir, { recursive: true });
  }
  executable = path.join(bin, path.basename(process.execPath));
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, (await fs.stat(process.execPath)).mode);
  script = path.join(root, "record launch.cjs");
  resultFile = path.join(root, "launched.json");
  await fs.writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd(),steamAppId:process.env.SteamAppId}));\n`
  );
  settingsFile = path.join(launcherPath, "launcher-settings.json");
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      formatVersion: 0,
      gameId: "ck3",
      gameDataPath: userDataPath,
      exePath: executable,
      exeArgs: [script],
      dlcPath: "../game",
    })
  );
  await fs.writeFile(
    path.join(root, ".px-toolkit/pxtk.json"),
    JSON.stringify({ game: "ck3", gamePath, userDataPath, logsPath: null, tigerPath: null })
  );
  loadFile = path.join(userDataPath, "dlc_load.json");
  await fs.writeFile(
    loadFile,
    JSON.stringify({ enabled_mods: [], disabled_dlcs: [], unrelated: { kept: true } })
  );
  await fs.writeFile(path.join(mod, "descriptor.mod"), '\uFEFFname="Fixture mod"\n');
  await fs.mkdir(path.join(userDataPath, "mod"));
  await fs.writeFile(
    path.join(userDataPath, "mod/fixture.mod"),
    `\uFEFFname="Fixture mod"\npath="${mod.replaceAll("\\", "/")}"\n`
  );
  databaseFile = path.join(userDataPath, "launcher-v2.sqlite");
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec(`CREATE TABLE playsets(id TEXT PRIMARY KEY,name TEXT,isActive INTEGER,isRemoved INTEGER,loadOrder TEXT);
CREATE TABLE playsets_mods(playsetId TEXT,modId TEXT,enabled INTEGER,position INTEGER);
CREATE TABLE mods(id TEXT PRIMARY KEY,name TEXT,displayName TEXT,gameRegistryId TEXT,dirPath TEXT,archivePath TEXT,status TEXT);
CREATE TABLE playsets_dlcs(playsetId TEXT,dlcId TEXT,enabled INTEGER);
CREATE TABLE dlc(id TEXT,name TEXT,dirPath TEXT);
INSERT INTO playsets VALUES('fixture','Fixture playset',0,0,'custom');
INSERT INTO playsets_mods VALUES('fixture','mod-fixture',1,0);`);
    db.prepare("INSERT INTO mods VALUES(?,?,?,?,?,?,?)").run(
      "mod-fixture",
      "Fixture mod",
      "Fixture mod",
      "mod/fixture.mod",
      mod,
      null,
      "ready_to_play"
    );
  } finally {
    db.close();
  }
  [originalLoad, originalDatabase, originalSettings] = await Promise.all(
    [loadFile, databaseFile, settingsFile].map((file) => fs.readFile(file))
  );
});

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("previews exact CLI arguments without changing launcher files or starting a process", async () => {
  const preview = await run(...cliArgs(), "--", ...args.slice(1));
  expect(preview.code).toBe(0);
  expect(preview.body).toMatchObject({
    status: "ok",
    operation: "launch",
    data: {
      mode: "preview",
      executable,
      cwd: path.dirname(executable),
      args: [script, ...args],
      steamAppId: gameMetas.ck3.steamAppId,
      playset: { id: "fixture", name: "Fixture playset", active: false },
      backupFile: null,
      process: null,
      launcherSelectionChanged: false,
      gameplayTested: false,
      loadSettings: {
        file: loadFile,
        format: "dlc",
        changed: true,
        beforeSha256: sha256(originalLoad),
        data: { enabled_mods: ["mod/fixture.mod"], disabled_dlcs: [], unrelated: { kept: true } },
      },
    },
  });
  expect(await fs.readFile(loadFile)).toEqual(originalLoad);
  expect(await fs.readFile(databaseFile)).toEqual(originalDatabase);
  expect(await fs.readFile(settingsFile)).toEqual(originalSettings);
  await expect(fs.access(resultFile)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.access(path.join(path.dirname(loadFile), ".pxtk-launch"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects CLI start without a reviewed preview token before writes or process launch", async () => {
  const result = await run(...cliArgs(), "--start", "--", ...args.slice(1));
  expect(result.code).toBe(2);
  expect(result.body).toMatchObject({ status: "error", error: { code: "preview_required" } });
  expect(await fs.readFile(loadFile)).toEqual(originalLoad);
  await expect(fs.access(resultFile)).rejects.toMatchObject({ code: "ENOENT" });
});

it("exposes playsets and a launch preview with valid MCP schemas and action annotations", async () => {
  const client = new Client({ name: "launch-entry-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bundle, "mcp"],
        cwd: root,
        env,
        stderr: "pipe",
      })
    );
    const { tools } = await client.listTools();
    const launch = tools.find((tool) => tool.name === "pxtk_launch");
    const playsets = tools.find((tool) => tool.name === "pxtk_playsets");
    expect(launch?.outputSchema?.type).toBe("object");
    expect(playsets?.outputSchema?.type).toBe("object");
    expect(launch?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(playsets?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const listed = await client.callTool({ name: "pxtk_playsets", arguments: {} });
    expect(listed.isError).toBeUndefined();
    expect(responseSchema("playsets").safeParse(listed.structuredContent).success).toBe(true);
    expect(listed.structuredContent).toMatchObject({
      data: {
        playsets: [{ id: "fixture", name: "Fixture playset", mods: [{ id: "mod-fixture", enabled: true }] }],
      },
    });
    const preview = await client.callTool({
      name: "pxtk_launch",
      arguments: { playset: "Fixture playset", args },
    });
    expect(preview.isError).toBeUndefined();
    expect(responseSchema("launch").safeParse(preview.structuredContent).success).toBe(true);
    expect(preview.structuredContent).toMatchObject({
      operation: "launch",
      data: { mode: "preview", args: [script, ...args], process: null },
    });
    expect(await fs.readFile(loadFile)).toEqual(originalLoad);
    await expect(fs.access(resultFile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await client.close();
  }
});

it.skipIf(process.platform !== "win32" && process.platform !== "linux")(
  "starts only the copied Node fixture from a matching preview and preserves its backup and launcher selection",
  async () => {
    const preview = await run(...cliArgs(), "--", ...args.slice(1));
    const started = await run(
      ...cliArgs(),
      "--start",
      "--expect",
      preview.body.data.previewToken,
      "--",
      ...args.slice(1)
    );
    expect(started.code).toBe(0);
    expect(started.body.data).toMatchObject({
      mode: "started",
      args: [script, ...args],
      process: { state: "exited", exitCode: 0 },
      launcherSelectionChanged: false,
      gameplayTested: false,
    });
    expect(JSON.parse(await fs.readFile(resultFile, "utf8"))).toEqual({
      pid: started.body.data.process.pid,
      args,
      cwd: path.dirname(executable),
      steamAppId: String(gameMetas.ck3.steamAppId),
    });
    expect(await fs.readFile(started.body.data.backupFile)).toEqual(originalLoad);
    const saved = await fs.readFile(loadFile);
    expect(JSON.parse(saved.toString())).toEqual({
      enabled_mods: ["mod/fixture.mod"],
      disabled_dlcs: [],
      unrelated: { kept: true },
    });
    expect(started.body.data).toMatchObject({
      loadSettings: { beforeSha256: sha256(originalLoad), afterSha256: sha256(saved) },
    });
    expect(await fs.readFile(databaseFile)).toEqual(originalDatabase);
    expect(await fs.readFile(settingsFile)).toEqual(originalSettings);
    await expect(
      fs.access(path.join(path.dirname(loadFile), ".pxtk-launch/launch.lock"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
);
