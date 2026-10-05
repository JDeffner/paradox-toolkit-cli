import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Diagnostic } from "vscode-languageserver";
import type { Configuration } from "../src/config";
import type { LspSession } from "../src/lsp";
import { registerTools } from "../src/mcp";
import { responseSchema } from "../src/responses";
import type { Finding, TigerCompatibility } from "../src/validation";

const mocks = vi.hoisted(() => ({ version: vi.fn(), run: vi.fn(), diagnostics: vi.fn() }));
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
vi.mock("../src/lsp", () => ({
  withSession: async (
    _config: Configuration,
    action: (session: LspSession) => Promise<unknown>,
    signal?: AbortSignal
  ) => {
    signal?.throwIfAborted();
    return action({
      serverVersion: "fixture",
      status: { tokens: 1, tokensFromBundledDumps: true },
      diagnostics: mocks.diagnostics,
    } as unknown as LspSession);
  },
}));

// Authentic compatibility warning, without local directory messages.
const unsupported = `PLEASE UPDATE!

Tiger was made for Crusader Kings 3 version 1.19.0 (Scribe),
but the newer version 1.20.0.3 was detected in the game files.
This may lead to erroneous reports from Tiger.
Please check if there is a newer version of Tiger that supports this version.`;
interface ValidationResponse {
  status: string;
  error?: { code: string; message: string };
  warnings: string[];
  data: {
    complete: boolean;
    baselineApplied: boolean;
    baselineWritten?: string;
    newErrors: number;
    existingFindings: number;
    compatibility: TigerCompatibility;
    tiger: { status: string };
    findings: { items: Finding[]; total: number };
    newFindings: { items: Finding[]; total: number };
  };
}
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.clearAllMocks();
  // A process fixture, not a claim that this release supports a real game installation.
  mocks.version.mockResolvedValue({ stdout: "ck3-tiger 1.19.0\n", stderr: "" });
  mocks.run.mockResolvedValue({ reports: [], stdout: "[]", stderr: "", exitCode: 0 });
  mocks.diagnostics.mockImplementation((file: string, _language: string, text: string): Diagnostic[] => {
    if (path.basename(file) !== "probe.txt") return [];
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    return [
      { code: "fixture-warning", severity: 2, message: "Existing fixture warning", range },
      ...(text.includes("broken")
        ? [{ code: "fixture-error", severity: 1 as const, message: "New fixture error", range }]
        : []),
    ];
  });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(tigerConfigured = true) {
  await fs.mkdir(".local/testing", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/testing/pxtk-baseline-workflow-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const mod = path.join(root, "mod");
  const game = path.join(root, "game");
  await fs.mkdir(path.join(mod, ".px-toolkit"), { recursive: true });
  await fs.mkdir(game);
  await fs.mkdir(path.join(root, "launcher"));
  await fs.writeFile(path.join(root, "launcher/launcher-settings.json"), '{"rawVersion":"1.20.0.3"}');
  await fs.writeFile(path.join(mod, "descriptor.mod"), '\uFEFFname="baseline workflow fixture"\n');
  const source = path.join(mod, "probe.txt");
  await fs.writeFile(source, "\uFEFFprobe = { }\n");
  await fs.writeFile(
    path.join(mod, ".px-toolkit/pxtk.json"),
    JSON.stringify({
      game: "ck3",
      gamePath: game,
      logsPath: null,
      tigerPath: tigerConfigured ? process.execPath : null,
    })
  );
  const server = new McpServer({ name: "baseline-workflow", version: "fixture" });
  const client = new Client({ name: "baseline-workflow-client", version: "fixture" });
  const drain = registerTools(server, { cwd: mod, env: {} }, new AbortController().signal);
  cleanup.push(async () => {
    await drain();
    await client.close();
    await server.close();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  const tool = tools.tools.find((entry) => entry.name === "pxtk_validate");
  expect(tool?.inputSchema.properties).toHaveProperty("writeBaseline");
  expect(tool?.outputSchema).toBeDefined();
  const call = async (args: Record<string, unknown>) => {
    const raw = CallToolResultSchema.parse(await client.callTool({ name: "pxtk_validate", arguments: args }));
    const body = responseSchema("validate").parse(raw.structuredContent) as ValidationResponse;
    const text = raw.content.find((content) => content.type === "text");
    expect(text && JSON.parse(text.text)).toEqual(raw.structuredContent);
    return { raw, body };
  };
  return { mod, source, call };
}

describe("MCP baseline workflow", () => {
  it("creates a baseline, compares saved changes and recovers without overwriting it", async () => {
    const { mod, source, call } = await fixture();
    const relative = ".px-toolkit/before.json";
    const file = path.join(mod, relative);
    const created = await call({ writeBaseline: relative });
    expect(created.raw.isError).not.toBe(true);
    expect(created.body).toMatchObject({
      status: "ok",
      data: { complete: true, baselineWritten: file, newErrors: 0 },
    });
    const bytes = await fs.readFile(file);
    expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({
      schemaVersion: 1,
      type: "pxtk-baseline",
      findings: [expect.objectContaining({ code: "fixture-warning" })],
    });
    await fs.writeFile(source, "\uFEFFprobe = { broken = yes }\n");
    const changed = await call({ baseline: relative });
    expect(changed.body.data).toMatchObject({ baselineApplied: true, newErrors: 1, existingFindings: 1 });
    expect(changed.body.data.newFindings.items).toEqual([expect.objectContaining({ code: "fixture-error" })]);
    await fs.writeFile(source, "\uFEFFprobe = { }\n");
    const recovered = await call({ baseline: relative });
    expect(recovered.body.data).toMatchObject({ baselineApplied: true, newErrors: 0, existingFindings: 1 });
    expect(recovered.body.data.newFindings.total).toBe(0);
    const repeated = await call({ writeBaseline: relative });
    expect(repeated.raw.isError).toBe(true);
    expect(repeated.body).toMatchObject({
      status: "error",
      error: { code: "operation_failed", message: expect.stringContaining("EEXIST") },
    });
    expect(await fs.readFile(file)).toEqual(bytes);
  });
  it("rejects simultaneous baseline comparison and creation before validation or writes", async () => {
    const { mod, call } = await fixture();
    const rejected = await call({
      baseline: ".px-toolkit/before.json",
      writeBaseline: ".px-toolkit/after.json",
    });
    expect(rejected.raw.isError).toBe(true);
    expect(rejected.body).toMatchObject({ status: "error", error: { code: "invalid_arguments" } });
    expect(mocks.diagnostics).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    await expect(fs.access(path.join(mod, ".px-toolkit/after.json"))).rejects.toThrow();
  });
  it.each(["unavailable", "unsupported"] as const)(
    "preserves findings and refuses a baseline when Tiger is %s",
    async (mode) => {
      const { mod, source, call } = await fixture(mode !== "unavailable");
      await fs.writeFile(source, "\uFEFFprobe = { broken = yes }\n");
      if (mode === "unsupported")
        mocks.run.mockResolvedValue({
          reports: [
            {
              key: "fixture-tiger-error",
              severity: "Error",
              message: "Tiger fixture error",
              locations: [{ path: "probe.txt", linenr: 1, column: 1 }],
            },
          ],
          stdout: "[]",
          stderr: unsupported,
          exitCode: 1,
        });
      const result = await call({ writeBaseline: ".px-toolkit/refused.json" });
      expect(result.raw.isError).toBe(true);
      expect(result.body).toMatchObject({
        status: "incomplete",
        data: { complete: false, baselineApplied: false },
      });
      expect(result.body.data.baselineWritten).toBeUndefined();
      expect(result.body.data.findings.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ source: "structural", code: "fixture-error" })])
      );
      expect(result.body.warnings).toContain(
        "Baseline not created: structural and compatible Tiger validation must complete first."
      );
      if (mode === "unsupported") {
        expect(result.body.data.compatibility).toMatchObject({
          status: "unsupported",
          evidence: unsupported,
        });
        expect(result.body.data.tiger.status).toBe("complete");
        expect(result.body.data.findings.items).toEqual(
          expect.arrayContaining([expect.objectContaining({ source: "tiger", code: "fixture-tiger-error" })])
        );
        expect(result.body.data.newErrors).toBe(2);
      } else {
        expect(result.body.data.tiger.status).toBe("unavailable");
        expect(result.body.data.newErrors).toBe(1);
        expect(mocks.run).not.toHaveBeenCalled();
      }
      await expect(fs.access(path.join(mod, ".px-toolkit/refused.json"))).rejects.toThrow();
    }
  );
});
