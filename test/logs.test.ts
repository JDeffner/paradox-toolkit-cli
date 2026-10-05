import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { digest, type Configuration } from "../src/config";
import { logs } from "../src/logs";

const race = vi.hoisted(() => ({ file: "", afterStat: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const afterStat = async (file: unknown) => {
    if (file !== race.file) return;
    const action = race.afterStat;
    race.afterStat = undefined;
    await action?.();
  };
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const stat = await actual.stat(...args);
      await afterStat(args[0]);
      return stat;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", {
        value: async (...options: Parameters<typeof handle.stat>) => {
          const result = await stat(...options);
          await afterStat(args[0]);
          return result;
        },
      });
      return handle;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  race.file = "";
  race.afterStat = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  await fs.mkdir(".local", { recursive: true });
  const mod = await fs.mkdtemp(path.resolve(".local/audit-runtime-logs-"));
  roots.push(mod);
  const file = path.join(mod, "error.log");
  const bytes = Buffer.from("[10:00:00][engine.cpp:1]: Original record\n");
  await fs.writeFile(file, bytes);
  const config = { mod, meta: {}, logsPath: null } as Configuration;
  const request = { operation: "logs" as const, action: "checkpoint", file };
  return { mod, file: await fs.realpath(file), bytes, config, request };
}

it("rejects logs already larger than 32 MiB", async () => {
  const f = await fixture();
  await fs.truncate(f.file, 32 * 1024 * 1024 + 1);
  await expect(logs(f.config, f.request)).rejects.toMatchObject({ code: "log_too_large" });
});

it("keeps the byte limit when a live log grows after its size check", async () => {
  const f = await fixture();
  race.file = f.file;
  race.afterStat = () => fs.truncate(f.file, 32 * 1024 * 1024 + 1);
  await expect(logs(f.config, f.request)).rejects.toMatchObject({ code: "log_too_large" });
});

it("keeps checkpoint bytes and identity from the same file when the log is replaced", async () => {
  const f = await fixture();
  const replacement = path.join(f.mod, "replacement.log");
  await fs.writeFile(replacement, "[10:00:01][engine.cpp:1]: Replacement record\n");
  const stat = await fs.stat(f.file);
  race.file = f.file;
  race.afterStat = async () => {
    await fs.rename(f.file, path.join(f.mod, "rotated.log"));
    await fs.rename(replacement, f.file);
  };
  const result = await logs(f.config, f.request);
  expect(result.checkpoint).toMatchObject({
    offset: f.bytes.length,
    prefix: digest(f.bytes),
    identity: [stat.dev, stat.ino, stat.birthtimeMs].join(":"),
  });
  expect(await fs.readFile(f.file, "utf8")).toContain("Replacement record");
});
