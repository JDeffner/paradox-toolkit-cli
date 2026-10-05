import { expect, it } from "vitest";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { version } from "../package.json";

const exec = promisify(execFile);
const bundle = path.resolve("dist/pxtk.cjs");

async function run(...args: string[]) {
  try {
    return { ...(await exec(process.execPath, [bundle, ...args])), code: 0 };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    if (!result.stdout && !result.stderr) throw error;
    return result;
  }
}

it.each([[], ["--help"], ["status", "--help"]])("returns JSON help for %j with --json", async (...args) => {
  const result = await run(...args, "--json");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    schemaVersion: 1,
    version,
    help: expect.stringContaining("Usage:"),
  });
});

it("returns JSON version metadata and preserves plain version output", async () => {
  expect(JSON.parse((await run("--version", "--json")).stdout)).toEqual({ schemaVersion: 1, version });
  expect((await run("--version")).stdout).toBe(version + "\n");
});

it.each([["--unknown"], ["--game"]])(
  "labels native parser failures invalid_arguments for %j",
  async (...args) => {
    const result = await run(...args, "--json");
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      error: { code: "invalid_arguments" },
    });
  }
);

it("rejects --kind for create instead of ignoring it", async () => {
  const result = await run("create", "--kind", "event", "--json");
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "error",
    error: { code: "invalid_arguments", message: expect.stringContaining("positional") },
  });
});

it("does not treat an argument after -- as the JSON option", async () => {
  const result = await run("status", "--", "--json");
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Unexpected positional argument");
});
