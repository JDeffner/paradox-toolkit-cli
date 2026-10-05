import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { parseDescriptor } from "@px-lsp/protocol/descriptorMod";
import { digest, documentsFolder, type Configuration } from "./config";
import { ToolError } from "./errors";

export interface LauncherData {
  gameId: string;
  descriptor: Configuration["meta"]["descriptor"];
  settingsFile: string;
  settingsDigest: string;
  executable: string;
  baseArgs: string[];
  cwd: string;
  userDataPath: string;
  defaultUserDataPath: string | null;
  userDataMatchesGame: boolean;
  databasePath: string;
  dlcPath: string | null;
  formatVersion: 0 | 1 | "1.1";
  loadSettings: {
    file: string;
    digest: string;
    format: "dlc" | "content";
    data: Record<string, unknown>;
  };
}
export interface LauncherMod {
  id: string;
  name: string;
  enabled: boolean;
  position: number | string;
  path: string | null;
  registryId: string | null;
  status: string;
  archivePath: string | null;
}
export interface LauncherPlayset {
  id: string;
  name: string;
  active: boolean;
  loadOrder: string;
  mods: LauncherMod[];
  disabledDlcs: string[];
}
export interface PlaysetSelection {
  playset: LauncherPlayset;
  loadSettings: { file: string; beforeDigest: string; data: Record<string, unknown> };
  sourceDigests: { file: string; digest: string }[];
}

function invalid(message: string): never {
  throw new ToolError("unsupported_launcher_data", message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length || value.includes("\0"))
    invalid(`${label} must be a nonempty string.`);
  return value;
}
function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  return value;
}
function flag(value: unknown, label: string, nullable = false): boolean {
  if (value === 1) return true;
  if (value === 0 || (nullable && value === null)) return false;
  return invalid(`${label} must be 0 or 1.`);
}
async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function json(file: string): Promise<{ data: Record<string, unknown>; digest: string }> {
  try {
    const bytes = await fs.readFile(file);
    return {
      data: object(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")), file),
      digest: digest(bytes),
    };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("invalid_launcher_data", `Cannot read ${file}: ${String(error)}`);
  }
}
function expandDataPath(template: string, settingsDir: string): string {
  if (!["win32", "linux", "darwin"].includes(process.platform))
    invalid(`Unsupported launcher platform: ${process.platform}.`);
  let expanded = template;
  if (process.platform === "win32") expanded = expanded.replaceAll("%USER_DOCUMENTS%", documentsFolder());
  if (process.platform === "linux")
    expanded = expanded.replaceAll(
      "$LINUX_DATA_HOME",
      process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share")
    );
  if (process.platform !== "win32" && expanded.startsWith("~/"))
    expanded = path.join(os.homedir(), expanded.slice(2));
  if (/%[^%]+%|\$|^~/.test(expanded))
    invalid(
      `Unsupported launcher gameDataPath template: ${template}. Supply userDataPath for a relocated directory.`
    );
  return path.resolve(settingsDir, expanded);
}
function validateLoadSettings(data: Record<string, unknown>, format: "dlc" | "content"): void {
  if (format === "dlc") {
    for (const key of ["enabled_mods", "disabled_dlcs"]) array(data[key], key).forEach((x) => string(x, key));
  } else {
    for (const key of ["enabledMods", "enabledUGC"])
      array(data[key], key).forEach((x) => string(object(x, key).path, `${key}.path`));
    array(data.disabledDLC, "disabledDLC").forEach((x) =>
      string(object(x, "disabledDLC").paradoxAppId, "disabledDLC.paradoxAppId")
    );
  }
}

/** Installed launcher metadata supplies paths and base arguments; no launch or write occurs here. */
export async function readLauncher(config: Configuration): Promise<LauncherData> {
  if (!config.gamePath)
    throw new ToolError("game_path_required", "Configure an installed gamePath before launching.");
  const settingsFile = path.resolve(config.gamePath, "../launcher/launcher-settings.json");
  const settings = await json(settingsFile);
  if (settings.data.gameId !== config.game)
    invalid(`Launcher gameId does not match the selected game ${config.game}.`);
  const version = settings.data.formatVersion;
  if (version !== 0 && version !== 1 && version !== "1.1")
    invalid(`Unsupported launcher formatVersion: ${String(version)}.`);
  const format = config.meta.descriptor === "mod" ? "dlc" : "content";
  if ((format === "dlc") !== (version === 0))
    invalid("Launcher formatVersion does not match the game profile descriptor format.");
  const cwd = path.dirname(settingsFile);
  const executable = path.resolve(cwd, string(settings.data.exePath, "exePath"));
  if (!(await fs.stat(executable)).isFile()) invalid(`Launcher executable is not a file: ${executable}.`);
  const baseArgs = array(settings.data.exeArgs, "exeArgs").map((x) => string(x, "exeArgs entry"));
  let defaultUserDataPath: string | null;
  try {
    defaultUserDataPath = expandDataPath(string(settings.data.gameDataPath, "gameDataPath"), cwd);
  } catch (error) {
    if (!config.userDataPath || !(error instanceof ToolError)) throw error;
    defaultUserDataPath = null;
  }
  const userDataPath = config.userDataPath ? path.resolve(config.userDataPath) : defaultUserDataPath!;
  const canonical = async (folder: string) => {
    let real: string;
    try {
      real = await fs.realpath(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      real = path.resolve(folder);
    }
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  const userDataMatchesGame =
    defaultUserDataPath !== null &&
    (await canonical(userDataPath)) === (await canonical(defaultUserDataPath));
  const dlcFile = path.join(userDataPath, "dlc_load.json");
  const contentFile = path.join(userDataPath, "content_load.json");
  const [hasDlc, hasContent] = await Promise.all([exists(dlcFile), exists(contentFile)]);
  if (hasDlc && hasContent)
    invalid(
      "Both dlc_load.json and content_load.json exist. Resolve the ambiguous launcher load settings first."
    );
  const file = format === "dlc" ? dlcFile : contentFile;
  if (!(format === "dlc" ? hasDlc : hasContent))
    throw new ToolError(
      "launcher_setup_required",
      `Missing ${path.basename(file)}. Open the Paradox launcher for this installation and complete its initial setup, or configure userDataPath.`
    );
  const load = await json(file);
  validateLoadSettings(load.data, format);
  return {
    gameId: config.game,
    descriptor: config.meta.descriptor,
    settingsFile,
    settingsDigest: settings.digest,
    executable,
    baseArgs,
    cwd: path.dirname(executable),
    userDataPath,
    defaultUserDataPath,
    userDataMatchesGame,
    databasePath: path.join(userDataPath, "launcher-v2.sqlite"),
    dlcPath:
      settings.data.dlcPath === undefined
        ? null
        : path.resolve(cwd, string(settings.data.dlcPath, "dlcPath")),
    formatVersion: version,
    loadSettings: { file, digest: load.digest, format, data: load.data },
  };
}

function requireColumns(db: DatabaseSync, table: string, columns: string[]): void {
  const found = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
  );
  const missing = columns.filter((column) => !found.has(column));
  if (missing.length) invalid(`Unsupported launcher database: ${table} is missing ${missing.join(", ")}.`);
}

export async function readPlaysets(launcher: LauncherData): Promise<LauncherPlayset[]> {
  if (!(await exists(launcher.databasePath)))
    throw new ToolError(
      "launcher_setup_required",
      "Launcher playset database is missing. Open the Paradox launcher and create a playset first."
    );
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(launcher.databasePath, { readOnly: true });
  try {
    db.exec("BEGIN");
    requireColumns(db, "playsets", ["id", "name", "isActive", "isRemoved", "loadOrder"]);
    requireColumns(db, "playsets_mods", ["playsetId", "modId", "enabled", "position"]);
    requireColumns(db, "mods", [
      "id",
      "name",
      "displayName",
      "gameRegistryId",
      "dirPath",
      "archivePath",
      "status",
    ]);
    requireColumns(db, "playsets_dlcs", ["playsetId", "dlcId", "enabled"]);
    const result: LauncherPlayset[] = [];
    for (const row of db
      .prepare("SELECT id,name,isActive,isRemoved,loadOrder FROM playsets ORDER BY name,id")
      .all()) {
      if (flag(row.isRemoved, "playsets.isRemoved", true)) continue;
      const id = string(row.id, "playsets.id");
      const mods = db
        .prepare(
          "SELECT pm.modId,pm.enabled,pm.position,m.id,m.name,m.displayName,m.gameRegistryId,m.dirPath,m.archivePath,m.status FROM playsets_mods pm LEFT JOIN mods m ON m.id=pm.modId WHERE pm.playsetId=? ORDER BY pm.position"
        )
        .all(id)
        .map((mod): LauncherMod => {
          if (mod.id === null) invalid(`Playset ${id} references missing mod ${String(mod.modId)}.`);
          if (
            (typeof mod.position !== "number" || !Number.isFinite(mod.position)) &&
            (typeof mod.position !== "string" || !mod.position.length)
          )
            invalid(`Playset ${id} has an unsupported mod position.`);
          return {
            id: string(mod.id, "mods.id"),
            name: string(mod.displayName ?? mod.name ?? mod.id, "mods.name"),
            enabled: flag(mod.enabled, "playsets_mods.enabled"),
            position: mod.position as number | string,
            path: nullableString(mod.archivePath ?? mod.dirPath, "mods.path"),
            archivePath: nullableString(mod.archivePath, "mods.archivePath"),
            registryId: nullableString(mod.gameRegistryId, "mods.gameRegistryId"),
            status: string(mod.status, "mods.status"),
          };
        });
      // Launcher 2026.12 stores POPS identifiers here, not dlc table UUIDs.
      const disabledDlcs = db
        .prepare("SELECT dlcId,enabled FROM playsets_dlcs WHERE playsetId=? ORDER BY dlcId")
        .all(id)
        .filter((dlc) => !flag(dlc.enabled, "playsets_dlcs.enabled"))
        .map((dlc) => string(dlc.dlcId, "playsets_dlcs.dlcId"));
      result.push({
        id,
        name: string(row.name, "playsets.name"),
        active: flag(row.isActive, "playsets.isActive", true),
        loadOrder: string(row.loadOrder, "playsets.loadOrder"),
        mods,
        disabledDlcs,
      });
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("invalid_launcher_database", `Cannot read launcher playsets: ${String(error)}`);
  } finally {
    db.close();
  }
}

function descriptorValue(text: string, key: string): string | null {
  const values = parseDescriptor(text.replace(/^\uFEFF/, "")).filter((entry) => entry.key === key);
  if (!values.length) return null;
  if (values.length !== 1 || !/^"[^"\r\n]+"$/.test(values[0].value))
    invalid(`Descriptor ${key} must be a single quoted value.`);
  return values[0].value.slice(1, -1);
}
async function validateMod(
  launcher: LauncherData,
  mod: LauncherMod,
  sources: PlaysetSelection["sourceDigests"]
): Promise<string> {
  if (mod.status !== "ready_to_play")
    invalid(`Enabled mod ${mod.name} is not ready to play (${mod.status}). Repair it in the launcher first.`);
  if (!mod.path || !path.isAbsolute(mod.path))
    invalid(`Enabled mod ${mod.name} has no absolute installation path.`);
  const installed = await fs.stat(mod.path);
  if (mod.archivePath ? !installed.isFile() : !installed.isDirectory())
    invalid(`Enabled mod ${mod.name} has an invalid installation path.`);
  const readDescriptor = async (file: string) => {
    const bytes = await fs.readFile(file);
    sources.push({ file, digest: digest(bytes) });
    return bytes.toString("utf8");
  };
  const samePath = (a: string, b: string) => {
    const canonical = (p: string) =>
      process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
    return canonical(a) === canonical(b);
  };
  if (launcher.descriptor === "mod") {
    if (!mod.registryId || path.isAbsolute(mod.registryId) || path.extname(mod.registryId) !== ".mod")
      invalid(`Enabled mod ${mod.name} has an unsupported launcher registry path.`);
    const registryFile = path.resolve(launcher.userDataPath, mod.registryId);
    const relative = path.relative(launcher.userDataPath, registryFile);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      invalid(`Enabled mod ${mod.name} registry path escapes the user data folder.`);
    const registry = await readDescriptor(registryFile);
    if (!descriptorValue(registry, "name"))
      invalid(`Enabled mod ${mod.name} has no registry descriptor name.`);
    const target = descriptorValue(registry, mod.archivePath ? "archive" : "path");
    if (
      !target ||
      !path.isAbsolute(target) ||
      !samePath(target, mod.path) ||
      descriptorValue(registry, mod.archivePath ? "path" : "archive")
    )
      invalid(`Enabled mod ${mod.name} registry descriptor does not match its installed path.`);
    if (!mod.archivePath) {
      const descriptor = await readDescriptor(path.join(mod.path, "descriptor.mod"));
      if (!descriptorValue(descriptor, "name")) invalid(`Enabled mod ${mod.name} has no descriptor name.`);
    }
    return mod.registryId;
  }
  if (mod.archivePath)
    invalid(
      `Enabled metadata mod ${mod.name} uses an archive. Metadata archive validation is not supported.`
    );
  if (launcher.formatVersion !== "1.1")
    invalid(
      "This launcher format only loads archived mods. Directory playsets require launcher formatVersion 1.1."
    );
  const metadataFile = path.join(mod.path, ".metadata/metadata.json");
  const metadata = await json(metadataFile);
  sources.push({ file: metadataFile, digest: metadata.digest });
  string(metadata.data.name, `Enabled mod ${mod.name} metadata.name`);
  return mod.path;
}

async function disabledDlcPaths(
  launcher: LauncherData,
  ids: string[],
  sources: PlaysetSelection["sourceDigests"]
): Promise<string[]> {
  if (!ids.length) return [];
  if (!launcher.dlcPath) invalid("Launcher metadata has no dlcPath to resolve disabled DLC identifiers.");
  const mappings = new Map<string, { path: string; file: string; digest: string }[]>();
  const entries = await fs.readdir(path.join(launcher.dlcPath, "dlc"), {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".dlc")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(launcher.dlcPath, file).replaceAll("\\", "/");
    const bytes = await fs.readFile(file);
    const pops = descriptorValue(bytes.toString("utf8"), "pops_id");
    const source = { path: relative, file, digest: digest(bytes) };
    if (pops) mappings.set(pops, [...(mappings.get(pops) ?? []), source]);
    mappings.set(relative, [source]);
  }
  return ids.map((id) => {
    const candidates = mappings.get(id);
    if (!candidates || candidates.length !== 1)
      invalid(`Disabled DLC ${id} cannot be mapped uniquely to installed .dlc metadata.`);
    sources.push({ file: candidates[0].file, digest: candidates[0].digest });
    return candidates[0].path;
  });
}

export async function selectPlayset(launcher: LauncherData, selector: string): Promise<PlaysetSelection> {
  const playsets = await readPlaysets(launcher);
  const exactId = playsets.find((playset) => playset.id === selector);
  const matches = exactId ? [exactId] : playsets.filter((playset) => playset.name === selector);
  if (!matches.length)
    throw new ToolError(
      "playset_not_found",
      `No existing launcher playset has ID or exact name ${selector}.`
    );
  if (matches.length > 1)
    throw new ToolError(
      "ambiguous_playset",
      `More than one launcher playset is named ${selector}. Select its exact ID.`
    );
  const playset = matches[0];
  if (playset.loadOrder !== "custom")
    invalid(
      `Playset ${playset.name} uses unsupported loadOrder ${playset.loadOrder}. Set a custom order in the launcher.`
    );
  if (new Set(playset.mods.map((mod) => mod.position)).size !== playset.mods.length)
    invalid(`Playset ${playset.name} has duplicate mod positions; its order is ambiguous.`);
  const paths: string[] = [];
  const sourceDigests: PlaysetSelection["sourceDigests"] = [];
  for (const mod of playset.mods.filter((mod) => mod.enabled)) {
    try {
      paths.push(await validateMod(launcher, mod, sourceDigests));
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("invalid_playset_mod", `Cannot use enabled mod ${mod.name}: ${String(error)}`);
    }
  }
  const data = { ...launcher.loadSettings.data };
  if (launcher.loadSettings.format === "dlc") {
    data.enabled_mods = paths;
    data.disabled_dlcs = await disabledDlcPaths(launcher, playset.disabledDlcs, sourceDigests);
  } else {
    data.enabledMods = paths.map((modPath) => ({ path: modPath }));
    data.disabledDLC = playset.disabledDlcs.map((id) => ({ paradoxAppId: id }));
  }
  return {
    playset,
    loadSettings: { file: launcher.loadSettings.file, beforeDigest: launcher.loadSettings.digest, data },
    sourceDigests,
  };
}
