import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { ToolError, errorMessage } from "./errors";

const exec = promisify(execFile);
const initialObservationMs = 1_000;

// Query executable paths only. Neither command lines nor process environments leave the probe.
const windowsProbe = `
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:PXTK_PROCESS_TARGET)) { throw 'Missing process target' }
$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath)
ConvertTo-Json -InputObject $rows -Compress
`;

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function vanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

/** Match the executable file, never a process name or a command-line substring. */
export async function runningGamePids(executable: string): Promise<number[]> {
  try {
    const target = await fs.realpath(executable);
    const matches: number[] = [];
    if (process.platform === "win32") {
      const { stdout } = await exec(
        path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", windowsProbe],
        {
          env: { ...process.env, PXTK_PROCESS_TARGET: target },
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 8 * 1024 * 1024,
        }
      );
      const rows: unknown = JSON.parse(stdout.trim());
      if (!Array.isArray(rows)) throw new Error("Process probe returned an invalid response.");
      for (const row of rows as { ProcessId?: unknown; ExecutablePath?: unknown }[]) {
        if (typeof row.ProcessId !== "number" || typeof row.ExecutablePath !== "string") continue;
        try {
          if (samePath(await fs.realpath(row.ExecutablePath), target)) matches.push(row.ProcessId);
        } catch (error) {
          if (!vanished(error)) throw error;
        }
      }
    } else if (process.platform === "linux") {
      const uid = process.getuid!();
      for (const entry of await fs.readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          // Sensitive proc entries become root-owned for nondumpable processes,
          // even when the PID directory still belongs to the current user.
          const exe = `/proc/${entry}/exe`;
          if ((await fs.lstat(exe)).uid !== uid) continue;
          if (samePath(await fs.realpath(exe), target)) matches.push(Number(entry));
        } catch (error) {
          if (!vanished(error)) throw error;
        }
      }
    } else {
      throw new ToolError(
        "process_probe_unsupported",
        "This platform cannot verify running games by canonical executable path."
      );
    }
    return matches.sort((a, b) => a - b);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("process_probe_failed", `Cannot check running games: ${errorMessage(error)}`);
  }
}

export interface GameStartResult {
  pid: number;
  state: "running" | "exited";
  exitCode: number | null;
}

/** After spawn commits, finish observation even if the caller cancels. The user's game stays open. */
export function startGame(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  steamAppId?: number
): Promise<GameStartResult> {
  if (signal?.aborted) {
    return Promise.reject(new ToolError("operation_cancelled", "Game launch was cancelled before start."));
  }
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        cwd,
        shell: false,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ...(steamAppId ? { SteamAppId: String(steamAppId) } : {}) },
      });
    } catch (error) {
      reject(new ToolError("game_start_failed", `Cannot start game: ${errorMessage(error)}`));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    function cleanup() {
      if (timer) clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("spawn", onSpawn);
    }
    function onError(error: Error) {
      cleanup();
      reject(new ToolError("game_start_failed", `Cannot start game: ${error.message}`));
    }
    function onExit(code: number | null, exitSignal: NodeJS.Signals | null) {
      cleanup();
      if (code !== 0) {
        reject(
          new ToolError(
            "game_start_failed",
            `Game exited during startup (${exitSignal ? `signal ${exitSignal}` : `exit code ${code}`}).`
          )
        );
      } else {
        resolve({ pid: child.pid!, state: "exited", exitCode: code });
      }
    }
    function onSpawn() {
      timer = setTimeout(() => {
        cleanup();
        child.unref();
        resolve({ pid: child.pid!, state: "running", exitCode: null });
      }, initialObservationMs);
    }
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("spawn", onSpawn);
  });
}
