import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { digest, type Configuration } from "./config";
import type { PxtkRequest } from "./contract";
import { ToolError, errorMessage } from "./errors";
import { readLauncher, readPlaysets, selectPlayset } from "./launcherData";
import { runningGamePids, startGame } from "./launchProcess";
import { targetPath } from "./writes";

export async function listPlaysets(config: Configuration): Promise<Record<string, unknown>> {
  const launcher = await readLauncher(config);
  return {
    settingsFile: launcher.settingsFile,
    userDataPath: launcher.userDataPath,
    databasePath: launcher.databasePath,
    loadSettingsFile: launcher.loadSettings.file,
    presets: config.meta.launchPresets ?? [],
    playsets: await readPlaysets(launcher),
  };
}

async function planLaunch(config: Configuration, request: PxtkRequest) {
  const launcher = await readLauncher(config);
  if (!launcher.userDataMatchesGame)
    throw new ToolError(
      "user_data_mismatch",
      "The selected user-data folder differs from the game's launcher settings. It can be inspected, but cannot be used for launch."
    );
  const preset = config.meta.launchPresets?.find((entry) => entry.id === request.preset);
  if (request.preset && !preset)
    throw new ToolError(
      "unknown_preset",
      "Unknown preset. List the selected game's presets with pxtk playsets."
    );
  const args = [...launcher.baseArgs, ...(preset?.args ?? []), ...(request.args ?? [])];
  if (args.some((arg) => /^[-/]*userdir(?:=|$)/i.test(arg)))
    throw new ToolError(
      "unsupported_launch_argument",
      "userdir overrides are not supported because they can bypass the reviewed playset load settings."
    );
  const selection = request.playset ? await selectPlayset(launcher, request.playset) : null;
  const before = await fs.readFile(launcher.loadSettings.file);
  if (digest(before) !== launcher.loadSettings.digest)
    throw new ToolError("stale_preview", "Launcher load settings changed. Generate a fresh preview.");
  const data = selection?.loadSettings.data ?? launcher.loadSettings.data;
  const changed = JSON.stringify(data) !== JSON.stringify(launcher.loadSettings.data);
  const after = changed ? Buffer.from(JSON.stringify(data, null, 2) + "\n") : before;
  const executable = await fs.realpath(launcher.executable);
  const info = await fs.stat(executable);
  const output = {
    executable,
    cwd: launcher.cwd,
    args,
    steamAppId: config.meta.steamAppId,
    playset: selection?.playset ?? null,
    loadSettings: {
      file: launcher.loadSettings.file,
      format: launcher.loadSettings.format,
      changed,
      beforeSha256: digest(before),
      afterSha256: digest(after),
      data,
    },
    launcherSelectionChanged: false as const,
    gameplayTested: false as const,
  };
  const token = digest(
    JSON.stringify({
      output,
      settings: launcher.settingsDigest,
      selection,
      executable: [info.size, info.mtimeMs, info.ino],
    })
  );
  return { launcher, before, after, output, token };
}

/** Replace only the reviewed file; never overwrite a newer launcher or user edit. */
async function replaceLoadFile(config: Configuration, file: string, before: Buffer, after: Buffer) {
  await targetPath(config, file);
  const temp = await targetPath(config, path.join(path.dirname(file), ".pxtk-" + randomUUID() + ".tmp"));
  try {
    await fs.writeFile(temp, after, { flag: "wx", mode: 0o600 });
    await targetPath(config, file);
    if (!(await fs.readFile(file)).equals(before))
      throw new ToolError("stale_preview", "Launcher load settings changed before replacement.");
    await fs.chmod(temp, (await fs.stat(file)).mode);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function launchGame(
  config: Configuration,
  request: PxtkRequest,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const plan = await planLaunch(config, request);
  if (request.expect && request.expect !== plan.token)
    throw new ToolError("stale_preview", "Launch inputs or options changed. Generate a fresh preview.");
  const preview = {
    ...plan.output,
    mode: "preview",
    previewToken: plan.token,
    backupFile: null,
    process: null,
  };
  if (!request.start) return preview;
  if (!request.expect)
    throw new ToolError(
      "preview_required",
      "Preview the launch first, then use --start --expect <previewToken> with the same options."
    );
  const assertStopped = async () => {
    const pids = await runningGamePids(plan.output.executable);
    if (pids.length)
      throw new ToolError(
        "game_already_running",
        `The selected game is already running (PID ${pids.join(", ")}). Close it before launching another playset.`
      );
  };
  await assertStopped();
  signal?.throwIfAborted();
  const root = await fs.realpath(plan.launcher.userDataPath);
  const writer = { ...config, mod: root, parents: [] };
  const file = await targetPath(writer, path.join(root, path.basename(plan.launcher.loadSettings.file)));
  const stateDir = await targetPath(writer, path.join(root, ".pxtk-launch"));
  await fs.mkdir(stateDir, { recursive: true });
  const lockFile = await targetPath(writer, path.join(stateDir, "launch.lock"));
  let lock;
  try {
    lock = await fs.open(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ToolError(
        "launch_in_progress",
        `A launch lock exists at ${lockFile}. Wait for that command; if it crashed, remove the lock after confirming no launch is in progress.`
      );
    throw error;
  }
  let backupFile: string | null = null;
  let written = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, executable: plan.output.executable }));
    await assertStopped();
    if ((await planLaunch(config, request)).token !== plan.token)
      throw new ToolError("stale_preview", "Launch inputs changed before startup. Generate a fresh preview.");
    signal?.throwIfAborted();
    if (plan.output.loadSettings.changed) {
      backupFile = await targetPath(
        writer,
        path.join(stateDir, `${Date.now()}-${randomUUID()}-${path.basename(file)}.bak`)
      );
      await fs.writeFile(backupFile, plan.before, { flag: "wx", mode: 0o600 });
      await replaceLoadFile(writer, file, plan.before, plan.after);
      written = true;
    }
    const started = await startGame(
      plan.output.executable,
      plan.output.args,
      plan.output.cwd,
      signal,
      plan.output.steamAppId
    );
    return { ...preview, mode: "started", backupFile, process: started };
  } catch (error) {
    if (!written) throw error;
    let recovery: string;
    try {
      await replaceLoadFile(writer, file, plan.after, plan.before);
      recovery = "Original load settings restored.";
    } catch (restoreError) {
      recovery = `Load settings could not be restored without replacing a newer edit: ${errorMessage(restoreError)}.`;
    }
    throw new ToolError(
      error instanceof ToolError ? error.code : "game_start_failed",
      `${errorMessage(error)} ${recovery} Backup: ${backupFile}`
    );
  } finally {
    await lock.close();
    await fs.unlink(lockFile);
  }
}
