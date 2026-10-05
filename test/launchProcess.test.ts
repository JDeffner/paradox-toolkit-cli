import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runningGamePids, startGame } from "../src/launchProcess";

const linuxProbe = vi.hoisted(() => ({ enabled: false, inaccessible: false, inspected: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (file: string) =>
      linuxProbe.enabled && file === "/proc" ? Promise.resolve(["123", "456"]) : actual.readdir(file),
    stat: (file: string) =>
      linuxProbe.enabled && /^\/proc\/\d+$/.test(file)
        ? Promise.resolve({ uid: file === "/proc/123" ? 0 : 1000 })
        : actual.stat(file),
    realpath: async (file: string) => {
      if (linuxProbe.enabled) {
        if (file === "/test-executable") return "/same-game";
        if (/^\/proc\/\d+\/exe$/.test(file)) {
          linuxProbe.inspected.push(file);
          if (file === "/proc/123/exe" || linuxProbe.inaccessible)
            throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
          return "/same-game";
        }
      }
      return actual.realpath(file);
    },
  };
});

const roots: string[] = [];
const ownedPids = new Set<number>();

async function fixture() {
  await fs.mkdir(".local/testing", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/testing/pxtk-launch-"));
  roots.push(root);
  const script = path.join(root, "fixture with spaces.cjs");
  const result = path.join(root, "result.json");
  await fs.writeFile(
    script,
    `const fs = require('node:fs');
fs.writeFileSync('result.json', JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd(),steamAppId:process.env.SteamAppId}));
setInterval(() => {}, 1000);
`
  );
  return { root, script, result };
}

async function readResult(result: string) {
  return JSON.parse(await fs.readFile(result, "utf8")) as {
    pid: number;
    args: string[];
    cwd: string;
    steamAppId?: string;
  };
}

afterEach(async () => {
  // Fixture files record only processes this suite launched, including a launch whose assertion failed.
  for (const root of roots) {
    try {
      ownedPids.add((await readResult(path.join(root, "result.json"))).pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const pid of ownedPids) {
    try {
      process.kill(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      if (Date.now() >= deadline) throw new Error(`Owned fixture ${pid} did not terminate.`);
      await delay(20);
    }
  }
  ownedPids.clear();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

it("starts the exact executable with literal argument boundaries and the requested working directory", async () => {
  const { root, script, result } = await fixture();
  const args = ["two words", "& | ; $(literal) %PATH%", 'a"quote', "", "ending\\"];
  const started = await startGame(process.execPath, [script, ...args], root, undefined, 12345);
  ownedPids.add(started.pid);
  expect(started).toEqual({ pid: expect.any(Number), state: "running", exitCode: null });
  expect(await readResult(result)).toEqual({ pid: started.pid, args, cwd: root, steamAppId: "12345" });
});

it("reports a clean early exit", async () => {
  const { root } = await fixture();
  const started = await startGame(process.execPath, ["-e", "process.exit(0)"], root);
  expect(started).toEqual({ pid: expect.any(Number), state: "exited", exitCode: 0 });
});

it("rejects a nonzero early exit and invalid executable or working directory", async () => {
  const { root } = await fixture();
  await expect(startGame(process.execPath, ["-e", "process.exit(7)"], root)).rejects.toMatchObject({
    code: "game_start_failed",
    message: expect.stringContaining("exit code 7"),
  });
  await expect(startGame(path.join(root, "missing executable"), [], root)).rejects.toMatchObject({
    code: "game_start_failed",
  });
  await expect(startGame(process.execPath, [], path.join(root, "missing cwd"))).rejects.toMatchObject({
    code: "game_start_failed",
  });
});

it("cancels before spawn without starting the fixture", async () => {
  const { root, script, result } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(startGame(process.execPath, [script], root, controller.signal)).rejects.toMatchObject({
    code: "operation_cancelled",
  });
  await expect(fs.stat(result)).rejects.toMatchObject({ code: "ENOENT" });
});

it("observes a committed launch when cancellation arrives during startup", async () => {
  const { root, script, result } = await fixture();
  const controller = new AbortController();
  const pending = startGame(process.execPath, [script], root, controller.signal);
  controller.abort();
  const started = await pending;
  ownedPids.add(started.pid);
  expect(started.state).toBe("running");
  expect((await readResult(result)).pid).toBe(started.pid);
  expect(() => process.kill(started.pid, 0)).not.toThrow();
});

it("guards the current process by exact canonical executable and does not match another file", async () => {
  const { root } = await fixture();
  if (process.platform !== "win32" && process.platform !== "linux") {
    await expect(runningGamePids(process.execPath)).rejects.toMatchObject({
      code: "process_probe_unsupported",
    });
    return;
  }
  expect(await runningGamePids(await fs.realpath(process.execPath))).toContain(process.pid);
  const unrelated = path.join(root, path.basename(process.execPath));
  await fs.writeFile(unrelated, "different file with the same executable name");
  expect(await runningGamePids(unrelated)).toEqual([]);
}, 20_000);

it("reports a missing executable as a probe failure", async () => {
  const { root } = await fixture();
  await expect(runningGamePids(path.join(root, "missing"))).rejects.toMatchObject({
    code: "process_probe_failed",
  });
});

it("checks same-owner Linux executables and reports denied access for that owner", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  linuxProbe.enabled = true;
  linuxProbe.inspected = [];
  try {
    expect(await runningGamePids("/test-executable")).toEqual([456]);
    expect(linuxProbe.inspected).toEqual(["/proc/456/exe"]);
    linuxProbe.inaccessible = true;
    await expect(runningGamePids("/test-executable")).rejects.toMatchObject({ code: "process_probe_failed" });
  } finally {
    linuxProbe.enabled = false;
    linuxProbe.inaccessible = false;
    Object.defineProperty(process, "platform", platform);
    if (getuid) Object.defineProperty(process, "getuid", getuid);
    else Reflect.deleteProperty(process, "getuid");
  }
});
