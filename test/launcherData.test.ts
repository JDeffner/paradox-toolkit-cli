import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { gameMetas } from "@px-lsp/server/games/metaRegistry";
import type { Configuration } from "../src/config";
import { readLauncher, readPlaysets, selectPlayset } from "../src/launcherData";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(game = "ck3") {
  await fs.mkdir(".local/testing", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/testing/pxtk-launcher-"));
  roots.push(root);
  const gamePath = path.join(root, "install/game");
  const launcherPath = path.join(root, "install/launcher");
  const userDataPath = path.join(root, "user-data");
  await Promise.all([gamePath, launcherPath, userDataPath].map((p) => fs.mkdir(p, { recursive: true })));
  const settings = {
    gameId: game,
    formatVersion: gameMetas[game].descriptor === "mod" ? 0 : "1.1",
    gameDataPath: userDataPath,
    exePath: "../bin/game.exe",
    exeArgs: ["-base"],
    dlcPath: "../game",
  };
  await fs.mkdir(path.join(root, "install/bin"));
  await fs.writeFile(path.join(root, "install/bin/game.exe"), "fixture");
  const settingsFile = path.join(launcherPath, "launcher-settings.json");
  await fs.writeFile(settingsFile, JSON.stringify(settings));
  const loadFile = path.join(
    userDataPath,
    gameMetas[game].descriptor === "mod" ? "dlc_load.json" : "content_load.json"
  );
  const load =
    gameMetas[game].descriptor === "mod"
      ? { enabled_mods: [], disabled_dlcs: [], unrelated: { kept: true } }
      : {
          enabledMods: [],
          disabledDLC: [],
          enabledUGC: [{ path: "preserved/global/ugc" }],
          unrelated: { kept: true },
        };
  await fs.writeFile(loadFile, JSON.stringify(load));
  const databasePath = path.join(userDataPath, "launcher-v2.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE playsets(id TEXT PRIMARY KEY,name TEXT,isActive INTEGER,isRemoved INTEGER,loadOrder TEXT);
    CREATE TABLE playsets_mods(playsetId TEXT,modId TEXT,enabled INTEGER,position INTEGER);
    CREATE TABLE mods(id TEXT PRIMARY KEY,name TEXT,displayName TEXT,gameRegistryId TEXT,dirPath TEXT,archivePath TEXT,status TEXT);
    CREATE TABLE playsets_dlcs(playsetId TEXT,dlcId TEXT,enabled INTEGER);
    CREATE TABLE dlc(id TEXT,name TEXT,dirPath TEXT);
    INSERT INTO playsets VALUES('selected','Testing',1,0,'custom');`);
  db.close();
  const config = { game, meta: gameMetas[game], gamePath, userDataPath } as Configuration;
  return { root, config, settings, settingsFile, userDataPath, loadFile, load, databasePath, gamePath };
}
function editDb(file: string, sql: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
async function addMod(f: Awaited<ReturnType<typeof fixture>>, id: string, position: number, enabled = true) {
  const dir = path.join(f.root, `mods/${id}`);
  await fs.mkdir(dir, { recursive: true });
  const registryId = f.config.meta.descriptor === "mod" ? `mod/${id}.mod` : null;
  if (registryId) {
    await fs.writeFile(path.join(dir, "descriptor.mod"), `name="${id}"`);
    await fs.mkdir(path.join(f.userDataPath, "mod"), { recursive: true });
    await fs.writeFile(
      path.join(f.userDataPath, registryId),
      `name="${id}"\npath="${dir.replaceAll("\\", "/")}"`
    );
  } else {
    await fs.mkdir(path.join(dir, ".metadata"));
    await fs.writeFile(path.join(dir, ".metadata/metadata.json"), JSON.stringify({ name: id }));
  }
  const db = new DatabaseSync(f.databasePath);
  try {
    db.prepare("INSERT INTO mods VALUES(?,?,?,?,?,?,?)").run(
      id,
      id,
      id,
      registryId,
      dir,
      null,
      "ready_to_play"
    );
    db.prepare("INSERT INTO playsets_mods VALUES(?,?,?,?)").run("selected", id, enabled ? 1 : 0, position);
  } finally {
    db.close();
  }
  return dir;
}

it("reads executable and base arguments only from selected installed launcher metadata", async () => {
  const f = await fixture();
  const launcher = await readLauncher(f.config);
  expect(launcher.executable).toBe(path.join(f.root, "install/bin/game.exe"));
  expect(launcher.baseArgs).toEqual(["-base"]);
  expect(launcher.defaultUserDataPath).toBe(f.userDataPath);
  expect(launcher.userDataMatchesGame).toBe(true);
  expect(launcher.cwd).toBe(path.dirname(launcher.executable));
  await fs.rm(f.databasePath);
  await expect(readLauncher(f.config)).resolves.toMatchObject({ gameId: "ck3" });
  await expect(readPlaysets(launcher)).rejects.toThrow("create a playset");
});
it("requires initial launcher setup, rejects ambiguous load files, wrong game, and unknown format", async () => {
  const f = await fixture();
  await fs.rm(f.loadFile);
  await expect(readLauncher(f.config)).rejects.toThrow("initial setup");
  await fs.writeFile(f.loadFile, JSON.stringify(f.load));
  await fs.writeFile(path.join(f.userDataPath, "content_load.json"), "{}");
  await expect(readLauncher(f.config)).rejects.toThrow("Both");
  await fs.rm(path.join(f.userDataPath, "content_load.json"));
  await fs.writeFile(f.settingsFile, JSON.stringify({ ...f.settings, gameId: "vic3" }));
  await expect(readLauncher(f.config)).rejects.toThrow("does not match");
  await fs.writeFile(f.settingsFile, JSON.stringify({ ...f.settings, formatVersion: 7 }));
  await expect(readLauncher(f.config)).rejects.toThrow("formatVersion");
});
it("keeps relocation queries readable but exposes unknown or mismatching game data directories", async () => {
  const f = await fixture();
  await fs.writeFile(f.settingsFile, JSON.stringify({ ...f.settings, gameDataPath: "$UNKNOWN_DATA" }));
  expect(await readLauncher(f.config)).toMatchObject({
    defaultUserDataPath: null,
    userDataMatchesGame: false,
  });
  await expect(readLauncher({ ...f.config, userDataPath: undefined })).rejects.toThrow("Unsupported");
  const other = path.join(f.root, "other");
  await fs.mkdir(other);
  await fs.writeFile(f.settingsFile, JSON.stringify({ ...f.settings, gameDataPath: other }));
  expect(await readLauncher(f.config)).toMatchObject({
    defaultUserDataPath: other,
    userDataMatchesGame: false,
  });
});
it("selects exact IDs before exact unique names and excludes removed playsets", async () => {
  const f = await fixture();
  editDb(
    f.databasePath,
    "INSERT INTO playsets VALUES('other','selected',0,0,'custom'),('removed','Removed',0,1,'custom')"
  );
  const launcher = await readLauncher(f.config);
  expect((await readPlaysets(launcher)).map((p) => p.id)).toEqual(["selected", "other"]);
  expect((await selectPlayset(launcher, "selected")).playset.id).toBe("selected");
  expect((await selectPlayset(launcher, "Testing")).playset.id).toBe("selected");
  await expect(selectPlayset(launcher, "Removed")).rejects.toThrow("No existing");
  await expect(selectPlayset(launcher, "testing")).rejects.toThrow("No existing");
  editDb(f.databasePath, "INSERT INTO playsets VALUES('duplicate','Testing',0,0,'custom')");
  await expect(selectPlayset(launcher, "Testing")).rejects.toThrow("More than one");
});
it("preserves enabled mod order, ignores disabled broken installations, and only plans a load change", async () => {
  const f = await fixture();
  await addMod(f, "later", 3);
  const broken = await addMod(f, "disabled", 2, false);
  await addMod(f, "first", 1);
  await fs.rm(broken, { recursive: true });
  editDb(f.databasePath, "UPDATE mods SET status='invalid_mod' WHERE id='disabled'");
  const before = await fs.readFile(f.loadFile, "utf8");
  const launcher = await readLauncher(f.config);
  const result = await selectPlayset(launcher, "selected");
  expect(result.playset.mods.map((m) => m.id)).toEqual(["first", "disabled", "later"]);
  expect(result.loadSettings.data).toEqual({
    enabled_mods: ["mod/first.mod", "mod/later.mod"],
    disabled_dlcs: [],
    unrelated: { kept: true },
  });
  expect(result.loadSettings.beforeDigest).toBe(launcher.loadSettings.digest);
  expect(result.sourceDigests.map((source) => path.basename(source.file))).toEqual([
    "first.mod",
    "descriptor.mod",
    "later.mod",
    "descriptor.mod",
  ]);
  expect(await fs.readFile(f.loadFile, "utf8")).toBe(before);
});
it("rejects missing database columns, missing mod rows, unsupported load orders and duplicate positions", async () => {
  const f = await fixture();
  const launcher = await readLauncher(f.config);
  editDb(f.databasePath, "INSERT INTO playsets_mods VALUES('selected','missing',1,1)");
  await expect(readPlaysets(launcher)).rejects.toThrow("missing mod");
  editDb(f.databasePath, "DELETE FROM playsets_mods; UPDATE playsets SET loadOrder='alphabetical'");
  await expect(selectPlayset(launcher, "selected")).rejects.toThrow("loadOrder");
  editDb(f.databasePath, "UPDATE playsets SET loadOrder='custom'");
  await addMod(f, "one", 1);
  await addMod(f, "two", 1);
  await expect(selectPlayset(launcher, "selected")).rejects.toThrow("duplicate mod positions");
  editDb(f.databasePath, "ALTER TABLE mods RENAME COLUMN status TO oldStatus");
  await expect(readPlaysets(launcher)).rejects.toThrow("missing status");
});
it("rejects enabled broken mod directories, not-ready mods, and mismatched registry descriptors", async () => {
  const f = await fixture();
  const dir = await addMod(f, "one", 1);
  const launcher = await readLauncher(f.config);
  editDb(f.databasePath, "UPDATE mods SET status='invalid_mod'");
  await expect(selectPlayset(launcher, "selected")).rejects.toThrow("not ready");
  editDb(f.databasePath, "UPDATE mods SET status='ready_to_play'");
  await fs.writeFile(path.join(f.userDataPath, "mod/one.mod"), 'name="one"\npath="C:/not-the-mod"');
  await expect(selectPlayset(launcher, "selected")).rejects.toThrow("does not match");
  await fs.rm(dir, { recursive: true });
  await expect(selectPlayset(launcher, "selected")).rejects.toThrow("Cannot use enabled mod");
});
it("maps disabled DLC POPS IDs from installed metadata instead of unrelated database UUIDs", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.gamePath, "dlc/expansion"), { recursive: true });
  await fs.writeFile(
    path.join(f.gamePath, "dlc/expansion/expansion.dlc"),
    'name="Expansion"\npops_id="example_expansion"'
  );
  editDb(
    f.databasePath,
    "INSERT INTO dlc VALUES('unrelated-uuid','Expansion','unused'); INSERT INTO playsets_dlcs VALUES('selected','example_expansion',0),('selected','enabled_expansion',1)"
  );
  const launcher = await readLauncher(f.config);
  expect((await selectPlayset(launcher, "selected")).loadSettings.data.disabled_dlcs).toEqual([
    "dlc/expansion/expansion.dlc",
  ]);
  editDb(f.databasePath, "INSERT INTO playsets_dlcs VALUES('selected','missing_expansion',0)");
  await expect(selectPlayset(launcher, "selected")).rejects.toThrow("cannot be mapped");
});
it.each(["vic3", "eu5"])(
  "builds %s metadata load settings with ordered paths, POPS identifiers, and preserved global UGC",
  async (game) => {
    const f = await fixture(game);
    const later = await addMod(f, "later", 5);
    const first = await addMod(f, "first", 1);
    editDb(f.databasePath, "INSERT INTO playsets_dlcs VALUES('selected','example_expansion',0)");
    const result = await selectPlayset(await readLauncher(f.config), "selected");
    expect(result.loadSettings.data).toEqual({
      enabledMods: [{ path: first }, { path: later }],
      disabledDLC: [{ paradoxAppId: "example_expansion" }],
      enabledUGC: [{ path: "preserved/global/ugc" }],
      unrelated: { kept: true },
    });
  }
);
it("rejects malformed content settings and unsupported archive mods instead of silently omitting content", async () => {
  const f = await fixture("vic3");
  await fs.writeFile(f.loadFile, JSON.stringify({ ...f.load, disabledDLC: ["incorrect-string-format"] }));
  await expect(readLauncher(f.config)).rejects.toThrow("must be an object");
  await fs.writeFile(f.loadFile, JSON.stringify(f.load));
  await addMod(f, "archive", 1);
  const archive = path.join(f.root, "archive.zip");
  await fs.writeFile(archive, "archive fixture");
  const db = new DatabaseSync(f.databasePath);
  db.prepare("UPDATE mods SET archivePath=?").run(archive);
  db.close();
  await expect(selectPlayset(await readLauncher(f.config), "selected")).rejects.toThrow("archive");
});

it("accepts registered CK3 archives and rejects changed or missing archive pointers", async () => {
  const f = await fixture();
  await addMod(f, "archive", 1);
  const archive = path.join(f.root, "content.zip");
  await fs.writeFile(archive, "archive fixture");
  const db = new DatabaseSync(f.databasePath);
  db.prepare("UPDATE mods SET dirPath=NULL,archivePath=?").run(archive);
  db.close();
  const registryFile = path.join(f.userDataPath, "mod/archive.mod");
  await fs.writeFile(registryFile, `name="archive"\narchive="${archive.replaceAll("\\", "/")}"`);
  const launcher = await readLauncher(f.config);
  const result = await selectPlayset(launcher, "selected");
  expect(result.loadSettings.data.enabled_mods).toEqual(["mod/archive.mod"]);
  expect(result.sourceDigests.map((source) => source.file)).toEqual([registryFile]);
  await fs.writeFile(registryFile, 'name="archive"\narchive="C:/different.zip"');
  await expect(selectPlayset(launcher, "selected")).rejects.toThrow("does not match");
  await fs.rm(archive);
  await expect(selectPlayset(launcher, "selected")).rejects.toThrow("Cannot use enabled mod");
});
