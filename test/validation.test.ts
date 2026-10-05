import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveConfig } from "../src/config";
import type { LspSession } from "../src/lsp";
import { tigerCompatibility, validate, writeBaseline } from "../src/validation";

const mocks = vi.hoisted(() => ({ version: vi.fn(), run: vi.fn(), dispose: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), {
      [Symbol.for("nodejs.util.promisify.custom")]: mocks.version,
    }),
  };
});
vi.mock("@px-lsp/protocol/tigerProcess", () => ({
  startTiger: (...args: unknown[]) => ({ result: mocks.run(...args) }),
}));
vi.mock("@px-lsp/protocol/tigerConfig", () => ({
  prepareTigerConfig: () => ({ source: null, text: "", args: [], dispose: mocks.dispose }),
}));

// Warning copied from the real CK3 run, without its machine-specific directory messages.
const unsupported = `PLEASE UPDATE!

Tiger was made for Crusader Kings 3 version 1.19.0 (Scribe),
but the newer version 1.20.0.3 was detected in the game files.
This may lead to erroneous reports from Tiger.
Please check if there is a newer version of Tiger that supports this version.`;
const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.version.mockResolvedValue({ stdout: "ck3-tiger 1.19.0\n", stderr: "" });
  mocks.run.mockResolvedValue({ reports: [], stdout: "[]", stderr: "", exitCode: 0 });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  await fs.mkdir(".local/testing", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/testing/pxtk-validation-"));
  roots.push(root);
  const mod = path.join(root, "mod");
  const gamePath = path.join(root, "game");
  await fs.mkdir(mod);
  await fs.mkdir(gamePath);
  await fs.mkdir(path.join(root, "launcher"));
  await fs.writeFile(path.join(root, "launcher/launcher-settings.json"), '{"rawVersion":"1.20.0.3"}');
  await fs.writeFile(path.join(mod, "descriptor.mod"), '\uFEFFname="validation fixture"\n');
  await fs.writeFile(path.join(mod, "probe.txt"), "\uFEFFprobe = { }\n");
  const config = await resolveConfig({
    cwd: mod,
    env: {},
    overrides: { game: "ck3", gamePath, logsPath: null, tigerPath: process.execPath },
  });
  const session = {
    serverVersion: "fixture",
    diagnostics: vi.fn().mockResolvedValue([]),
  } as unknown as LspSession;
  return { config, session, mod };
}

describe("Tiger compatibility", () => {
  it("retains Tiger's actual warning as evidence and handles CRLF", () => {
    expect(tigerCompatibility("1.20.0.3", "ck3-tiger 1.19.0", unsupported)).toEqual({
      status: "unsupported",
      gameVersion: "1.20.0.3",
      validatorVersion: "ck3-tiger 1.19.0",
      evidence: unsupported,
      reason: expect.stringContaining("findings may be erroneous"),
    });
    expect(tigerCompatibility(null, null, unsupported.replace(/\n/g, "\r\n")).status).toBe("unsupported");
  });
  it("does not infer support or incompatibility from release numbers or ordinary stderr", () => {
    for (const validator of ["ck3-tiger 1.19.0", "ck3-tiger 1.20.0.3"])
      expect(tigerCompatibility("1.20.0.3", validator, "Using conf file: fixture.conf\n")).toMatchObject({
        status: "unknown",
        evidence: null,
      });
    expect(tigerCompatibility(null, null)).toMatchObject({
      status: "unknown",
      gameVersion: null,
      validatorVersion: null,
    });
    expect(tigerCompatibility("mtime-123", "", unsupported)).toMatchObject({
      status: "unsupported",
      gameVersion: "1.20.0.3",
      validatorVersion: null,
    });
  });
  it("reads full stderr, preserves findings and blocks baseline use for unsupported runs", async () => {
    const { config, session, mod } = await fixture();
    const stderr = "Using fixture directory\n".repeat(200) + unsupported;
    mocks.run.mockResolvedValue({
      reports: [
        {
          key: "missing-reference",
          severity: "Error",
          message: "Missing reference",
          info: "Expected definition",
          locations: [{ path: "probe.txt", linenr: 1, column: 1 }],
        },
      ],
      stdout: "[]",
      stderr,
      exitCode: 1,
    });
    const result = await validate(config, session, "fixture", path.join(mod, "absent-baseline.json"));
    expect(result.complete).toBe(false);
    expect(result.baselineApplied).toBe(false);
    expect(result.tiger).toMatchObject({
      status: "complete",
      version: "ck3-tiger 1.19.0",
      compatibility: { status: "unsupported", evidence: unsupported },
      stderr: stderr.slice(0, 4000),
    });
    expect(result.findings).toEqual([
      {
        source: "tiger",
        code: "missing-reference",
        severity: "error",
        message: "Missing reference\nExpected definition",
        file: "probe.txt",
        line: 1,
        column: 1,
      },
    ]);
    expect(result.newFindings).toEqual(result.findings);
    await expect(writeBaseline(path.join(mod, "baseline.json"), result, mod)).rejects.toThrow(
      "requires completed"
    );
    await expect(fs.access(path.join(mod, "baseline.json"))).rejects.toThrow();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("keeps completed ordinary runs usable and reports unavailable or failed runs honestly", async () => {
    const { config, session } = await fixture();
    mocks.run.mockResolvedValue({
      reports: [],
      stdout: "[]",
      stderr: "Using conf file: fixture.conf\n",
      exitCode: 0,
    });
    const ordinary = await validate(config, session, "fixture");
    expect(ordinary.complete).toBe(true);
    expect(ordinary.tiger.compatibility.status).toBe("unknown");
    expect(ordinary.tiger.stderr).toBe("Using conf file: fixture.conf\n");
    mocks.run.mockRejectedValue(new Error("Tiger returned incomplete JSON"));
    const failed = await validate(config, session, "fixture");
    expect(failed.complete).toBe(false);
    expect(failed.tiger).toMatchObject({
      status: "failed",
      reason: "Tiger returned incomplete JSON",
      compatibility: { status: "unknown", validatorVersion: "ck3-tiger 1.19.0" },
    });
    const unavailable = await validate({ ...config, tigerPath: null }, session, "fixture");
    expect(unavailable.complete).toBe(false);
    expect(unavailable.tiger).toMatchObject({
      status: "unavailable",
      compatibility: { status: "unknown", gameVersion: "1.20.0.3", validatorVersion: null },
    });
  });
});
