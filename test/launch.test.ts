import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gameMetas } from "@px-lsp/server/games/metaRegistry";
import type { Configuration } from "../src/config";
import { launchGame } from "../src/launch";
import { runningGamePids, startGame } from "../src/launchProcess";
import { ToolError } from "../src/errors";

vi.mock("../src/launchProcess", () => ({ runningGamePids: vi.fn(), startGame: vi.fn() }));
const roots: string[] = [];
beforeEach(() => {
  vi.mocked(runningGamePids).mockReset().mockResolvedValue([]);
  vi.mocked(startGame).mockReset().mockResolvedValue({ pid: 123, state: "running", exitCode: null });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  await fs.mkdir(".local/testing", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/testing/pxtk-launch-"));
  roots.push(root);
  const gamePath = path.join(root, "install/game");
  const launcherPath = path.join(root, "install/launcher");
  const binaryPath = path.join(root, "install/bin");
  const userDataPath = path.join(root, "user-data");
  await Promise.all(
    [gamePath, launcherPath, binaryPath, userDataPath].map((p) => fs.mkdir(p, { recursive: true }))
  );
  await fs.writeFile(path.join(binaryPath, "game.exe"), "fixture executable");
  const settings = {
    gameId: "ck3",
    formatVersion: 0,
    gameDataPath: userDataPath,
    exePath: "../bin/game.exe",
    exeArgs: ["-base"],
  };
  const settingsFile = path.join(launcherPath, "launcher-settings.json");
  await fs.writeFile(settingsFile, JSON.stringify(settings));
  const loadFile = path.join(userDataPath, "dlc_load.json");
  const before = Buffer.from(
    '{ "enabled_mods": ["mod/original.mod"], "disabled_dlcs": [], "unrelated": {"keep":true} }\n'
  );
  await fs.writeFile(loadFile, before);
  const databasePath = path.join(userDataPath, "launcher-v2.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE playsets(id TEXT PRIMARY KEY,name TEXT,isActive INTEGER,isRemoved INTEGER,loadOrder TEXT);
    CREATE TABLE playsets_mods(playsetId TEXT,modId TEXT,enabled INTEGER,position INTEGER);
    CREATE TABLE mods(id TEXT PRIMARY KEY,name TEXT,displayName TEXT,gameRegistryId TEXT,dirPath TEXT,archivePath TEXT,status TEXT);
    CREATE TABLE playsets_dlcs(playsetId TEXT,dlcId TEXT,enabled INTEGER);
    INSERT INTO playsets VALUES('selected','Vanilla',0,0,'custom');`);
  db.close();
  const config: Configuration = {
    game: "ck3",
    meta: gameMetas.ck3,
    gamePath,
    userDataPath,
    mod: root,
    logsPath: null,
    tigerPath: null,
    tigerConfig: null,
    parents: [],
    language: "english",
    timeoutMs: 30000,
    configFile: null,
    issues: [],
  };
  const request = {
    operation: "launch" as const,
    playset: "selected",
    args: ["-debug_mode", "literal space & $value"],
  };
  const preview = await launchGame(config, request);
  const start = { ...request, start: true, expect: preview.previewToken as string };
  return {
    root,
    config,
    settings,
    settingsFile,
    userDataPath,
    loadFile,
    before,
    databasePath,
    request,
    preview,
    start,
    binaryPath,
  };
}

it("previews exact arguments, executable folder, selected order and load changes without mutation", async () => {
  const f = await fixture();
  expect(f.preview).toMatchObject({
    mode: "preview",
    args: ["-base", "-debug_mode", "literal space & $value"],
    cwd: f.binaryPath,
    playset: { id: "selected", mods: [] },
    loadSettings: { changed: true, data: { enabled_mods: [], unrelated: { keep: true } } },
    backupFile: null,
    process: null,
  });
  expect(await fs.readFile(f.loadFile)).toEqual(f.before);
  expect(await fs.readdir(f.userDataPath)).toEqual(["dlc_load.json", "launcher-v2.sqlite"]);
  expect(startGame).not.toHaveBeenCalled();
  expect(runningGamePids).not.toHaveBeenCalled();
});
it("requires a token and rejects changed launch arguments, settings and playsets", async () => {
  const f = await fixture();
  await expect(launchGame(f.config, { ...f.request, start: true })).rejects.toMatchObject({
    code: "preview_required",
  });
  await expect(launchGame(f.config, { ...f.start, args: ["-different"] })).rejects.toMatchObject({
    code: "stale_preview",
  });
  await fs.writeFile(f.settingsFile, JSON.stringify({ ...f.settings, exeArgs: ["-changed"] }));
  await expect(launchGame(f.config, f.start)).rejects.toMatchObject({ code: "stale_preview" });
  await fs.writeFile(f.settingsFile, JSON.stringify(f.settings));
  const db = new DatabaseSync(f.databasePath);
  db.exec("UPDATE playsets SET name='Changed'");
  db.close();
  await expect(launchGame(f.config, f.start)).rejects.toMatchObject({ code: "stale_preview" });
  expect(startGame).not.toHaveBeenCalled();
  expect(await fs.readFile(f.loadFile)).toEqual(f.before);
});
it("refuses an already running game before creating any launch state or changing files", async () => {
  const f = await fixture();
  vi.mocked(runningGamePids).mockResolvedValue([42]);
  await expect(launchGame(f.config, f.start)).rejects.toMatchObject({ code: "game_already_running" });
  expect(await fs.readdir(f.userDataPath)).toEqual(["dlc_load.json", "launcher-v2.sqlite"]);
  expect(await fs.readFile(f.loadFile)).toEqual(f.before);
  expect(startGame).not.toHaveBeenCalled();
});
it("backs up exact bytes, preserves unrelated settings, and leaves the launcher database unchanged", async () => {
  const f = await fixture();
  const databaseBefore = await fs.readFile(f.databasePath);
  const output = await launchGame(f.config, f.start);
  expect(output).toMatchObject({
    mode: "started",
    process: { pid: 123, state: "running" },
    launcherSelectionChanged: false,
    gameplayTested: false,
  });
  expect(await fs.readFile(output.backupFile as string)).toEqual(f.before);
  expect(JSON.parse(await fs.readFile(f.loadFile, "utf8"))).toEqual({
    enabled_mods: [],
    disabled_dlcs: [],
    unrelated: { keep: true },
  });
  expect(await fs.readFile(f.databasePath)).toEqual(databaseBefore);
  expect(startGame).toHaveBeenCalledWith(
    path.join(f.binaryPath, "game.exe"),
    f.preview.args,
    f.binaryPath,
    undefined,
    gameMetas.ck3.steamAppId
  );
  expect(await fs.readdir(path.join(f.userDataPath, ".pxtk-launch"))).toEqual([
    path.basename(output.backupFile as string),
  ]);
});
it("omitting the playset retains existing load-file bytes and does not need a launcher database", async () => {
  const f = await fixture();
  await fs.rm(f.databasePath);
  const request = { operation: "launch" as const, preset: "mapeditor" };
  const preview = await launchGame(f.config, request);
  expect(preview).toMatchObject({
    playset: null,
    args: ["-base", "-mapeditor"],
    loadSettings: { changed: false },
  });
  const output = await launchGame(f.config, {
    ...request,
    start: true,
    expect: preview.previewToken as string,
  });
  expect(output.backupFile).toBeNull();
  expect(await fs.readFile(f.loadFile)).toEqual(f.before);
});
it("rejects unsupported presets and user-data redirection without writing", async () => {
  const f = await fixture();
  await expect(launchGame(f.config, { ...f.request, preset: "unknown" })).rejects.toMatchObject({
    code: "unknown_preset",
  });
  await expect(launchGame(f.config, { ...f.request, args: ["-userdir=elsewhere"] })).rejects.toMatchObject({
    code: "unsupported_launch_argument",
  });
  const elsewhere = path.join(f.root, "elsewhere");
  await fs.mkdir(elsewhere);
  await fs.writeFile(path.join(elsewhere, "dlc_load.json"), f.before);
  await expect(launchGame({ ...f.config, userDataPath: elsewhere }, f.request)).rejects.toMatchObject({
    code: "user_data_mismatch",
  });
  expect(startGame).not.toHaveBeenCalled();
});
it("rejects a load-file change during the running-process check", async () => {
  const f = await fixture();
  vi.mocked(runningGamePids).mockImplementationOnce(async () => {
    await fs.writeFile(f.loadFile, JSON.stringify({ enabled_mods: ["mod/newer.mod"], disabled_dlcs: [] }));
    return [];
  });
  await expect(launchGame(f.config, f.start)).rejects.toMatchObject({ code: "stale_preview" });
  expect(JSON.parse(await fs.readFile(f.loadFile, "utf8")).enabled_mods).toEqual(["mod/newer.mod"]);
  expect(startGame).not.toHaveBeenCalled();
});
it("restores exact prior load settings when process startup fails", async () => {
  const f = await fixture();
  vi.mocked(startGame).mockRejectedValue(new ToolError("game_start_failed", "fixture exit 7"));
  await expect(launchGame(f.config, f.start)).rejects.toMatchObject({
    code: "game_start_failed",
    message: expect.stringContaining("Original load settings restored"),
  });
  expect(await fs.readFile(f.loadFile)).toEqual(f.before);
  const backups = await fs.readdir(path.join(f.userDataPath, ".pxtk-launch"));
  expect(backups).toHaveLength(1);
  expect(await fs.readFile(path.join(f.userDataPath, ".pxtk-launch", backups[0]))).toEqual(f.before);
});
it("preserves a newer load-file edit during failed startup and reports the backup", async () => {
  const f = await fixture();
  const newer = Buffer.from('{"enabled_mods":["mod/newer.mod"],"disabled_dlcs":[]}');
  vi.mocked(startGame).mockImplementation(async () => {
    await fs.writeFile(f.loadFile, newer);
    throw new ToolError("game_start_failed", "fixture exit 7");
  });
  await expect(launchGame(f.config, f.start)).rejects.toMatchObject({
    code: "game_start_failed",
    message: expect.stringMatching(/newer edit.*Backup:/s),
  });
  expect(await fs.readFile(f.loadFile)).toEqual(newer);
});
it("refuses an existing launch lock and linked load files", async () => {
  const f = await fixture();
  const state = path.join(f.userDataPath, ".pxtk-launch");
  await fs.mkdir(state);
  await fs.writeFile(path.join(state, "launch.lock"), "existing launch");
  await expect(launchGame(f.config, f.start)).rejects.toMatchObject({ code: "launch_in_progress" });
  await fs.unlink(path.join(state, "launch.lock"));
  await fs.link(f.loadFile, path.join(f.root, "hardlink.json"));
  await expect(launchGame(f.config, f.start)).rejects.toMatchObject({ code: "linked_destination" });
  expect(await fs.readFile(f.loadFile)).toEqual(f.before);
  expect(startGame).not.toHaveBeenCalled();
});
