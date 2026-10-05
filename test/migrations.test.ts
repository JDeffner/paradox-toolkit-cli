import { afterEach, beforeAll, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Worker } from "node:worker_threads";
import { digest, resolveConfig } from "../src/config";
import { migrationReport } from "../src/migrations";

// Source modules use src/__dirname; exercise the actual packaged worker instead.
const lifecycle = vi.hoisted(() => ({ workers: [] as Worker[] }));
vi.mock("node:worker_threads", async () => {
  const actual = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  const paths = await import("node:path");
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(_filename: string | URL, options: import("node:worker_threads").WorkerOptions) {
        super(paths.resolve("dist/migrations/worker.cjs"), options);
        lifecycle.workers.push(this);
      }
    },
  };
});

const roots: string[] = [];
beforeAll(async () => {
  await fs.access("dist/migrations/worker.cjs");
});
afterEach(async () => {
  // Every completion, including cancellation, must have awaited termination.
  for (const worker of lifecycle.workers.splice(0)) expect(worker.threadId).toBe(-1);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const manifest = {
  id: "fixture.setting",
  revision: "1",
  sdkVersion: 2,
  gameId: "ck3",
  fromVersion: "1.0.0",
  toVersion: "1.1.0",
  kind: "recipe",
  detection: "script",
  requirement: "required",
  title: "Synthetic setting fixture",
  description: "Test fixture",
  guidance: "Fixture only",
  limitations: ["No game runtime verification"],
  dependsOn: [],
  evidence: ["Synthetic input"],
  inputs: [{ root: "mod", path: "common", capture: "listing" }],
};
const code = `console.log("fixture log " + "x".repeat(20000));
module.exports = {
  manifest: ${JSON.stringify(manifest)},
  discover() { return [{ root: "mod", path: "common/test.txt" }]; },
  inspect() { return { applicability: "applicable", findings: [],
    questions: [{ id: "confirm", label: "Confirm fixture edit", kind: "boolean", required: true }],
    coverage: ["Synthetic input only"] }; },
  prepare(ctx) {
    const text = ctx.readText("mod", "common/test.txt");
    const start = text.indexOf("yes");
    return { groups: [{ id: "setting", title: "Setting", dependsOn: [], changes: [
      { kind: "text", path: "common/test.txt", edits: [{ start, end: start + 3, text: "no" }] },
      { kind: "create", path: "long.bin", bytes: new Uint8Array(20000).fill(255) }
    ] }], checks: [], unresolved: [] };
  }
};`;

async function fixture(artifactCode = code) {
  await fs.mkdir(".local", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/migrations-test-"));
  roots.push(root);
  const mod = path.join(root, "mod");
  await fs.mkdir(path.join(mod, "common"), { recursive: true });
  await fs.writeFile(path.join(mod, "descriptor.mod"), 'name="Migration fixture"');
  const file = path.join(mod, "common/test.txt");
  const before = Buffer.from("\uFEFFsetting = yes\n");
  await fs.writeFile(file, before);
  const recipe = path.join(root, "recipe.cjs");
  await fs.writeFile(recipe, artifactCode);
  const config = await resolveConfig({
    cwd: mod,
    env: {},
    overrides: { game: "ck3", gamePath: null, logsPath: null },
  });
  return { root, mod, file, before, recipe, config, trust: digest(Buffer.from(artifactCode)) };
}

it("discovers builtin catalog and exact routes without a workspace or game install", async () => {
  const { config } = await fixture();
  config.mod = "";
  const catalog = await migrationReport(config, { operation: "migrate", action: "catalog" });
  const entries = catalog.catalog as {
    items: { id: string; fromVersion: string; toVersion: string }[];
    total: number;
  };
  expect(entries.total).toBeGreaterThan(0);
  const first = entries.items[0];
  const routes = await migrationReport(config, {
    operation: "migrate",
    action: "routes",
    fromBuild: first.fromVersion,
    toBuild: first.toVersion,
  });
  expect(routes.issues).toEqual([]);
  expect(
    (routes.routes as { items: { entryIds: string[] }[] }).items.some((route) =>
      route.entryIds.includes(first.id)
    )
  ).toBe(true);
  const absent = await migrationReport(config, {
    operation: "migrate",
    action: "routes",
    fromBuild: "99.0.0",
    toBuild: "100.0.0",
  });
  expect(absent.issues).not.toEqual([]);
  expect((absent.routes as { total: number }).total).toBe(0);
});

it("reads untrusted bytes without evaluating code and rejects stale trust and invalid arguments", async () => {
  const { config, recipe } = await fixture('throw new Error("must not execute");');
  const untrusted = await migrationReport(config, {
    operation: "migrate",
    action: "preview",
    recipeFile: recipe,
  });
  expect(untrusted).toMatchObject({
    trustRequired: true,
    prepared: false,
    artifact: { trusted: false, bytes: Buffer.byteLength('throw new Error("must not execute");') },
  });
  expect(lifecycle.workers).toHaveLength(0);
  await expect(
    migrationReport(config, {
      operation: "migrate",
      action: "preview",
      recipeFile: recipe,
      trust: "0".repeat(64),
    })
  ).rejects.toMatchObject({ code: "stale_input" });
  await expect(
    migrationReport(config, {
      operation: "migrate",
      action: "preview",
      recipeFile: recipe,
      trust: digest(Buffer.from('throw new Error("must not execute");')),
      answers: { invalid: 7 } as never,
    })
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    migrationReport(config, { operation: "migrate", action: "routes", fromBuild: "1.x", toBuild: "2.0" })
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    migrationReport(config, {
      operation: "migrate",
      action: "catalog",
      recipeFile: recipe,
      fromBuild: "1.0.0",
    })
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    migrationReport(config, {
      operation: "migrate",
      action: "catalog",
      recipeFile: recipe,
      sourceGamePath: ".",
    })
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    migrationReport(config, {
      operation: "migrate",
      action: "routes",
      recipeFile: recipe,
      fromBuild: "1.0.0",
      toBuild: "1.1.0",
      answers: { confirm: true },
    })
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(lifecycle.workers).toHaveLength(0);
});

it("returns questions and prepares exact SDK2 edits without applying them", async () => {
  const { config, recipe, trust, file, before, mod } = await fixture();
  const request = { operation: "migrate" as const, action: "preview", recipeFile: recipe, trust };
  const blocked = await migrationReport(config, request);
  expect(blocked).toMatchObject({
    prepared: false,
    missingAnswers: ["confirm"],
    inspection: { applicability: "applicable" },
  });
  expect(blocked.blockedReasons).toContain("Required answers: confirm.");
  const preview = await migrationReport(config, { ...request, answers: { confirm: true }, limit: 1 });
  expect(preview).toMatchObject({
    trustRequired: false,
    prepared: true,
    blockedReasons: [],
    references: { source: { status: "unavailable" }, target: { status: "unavailable" } },
    diagnostics: { truncated: true },
  });
  const plan = preview.plan as {
    hash: string;
    snapshotHash: string;
    files: {
      total: number;
      truncated: boolean;
      items: {
        path: string;
        before: { sha256: string };
        after: { content: string; sha256: string; bytes: number };
      }[];
    };
  };
  expect(plan.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(plan.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  expect(plan.files).toMatchObject({
    total: 2,
    truncated: true,
    items: [
      {
        path: "common/test.txt",
        before: { sha256: digest(before) },
        after: {
          content: "\uFEFFsetting = no\n",
          sha256: digest(Buffer.from("\uFEFFsetting = no\n")),
          bytes: Buffer.byteLength("\uFEFFsetting = no\n"),
        },
      },
    ],
  });
  expect((preview.diagnostics as { stdout: string }).stdout.length).toBeLessThanOrEqual(8000);
  expect(await fs.readFile(file)).toEqual(before);
  await expect(fs.access(path.join(mod, "long.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  const full = await migrationReport(config, { ...request, answers: { confirm: true } });
  const binary = (
    full.plan as {
      files: {
        items: {
          path: string;
          after: { encoding: string; content: string; contentTruncated: boolean; bytes: number };
        }[];
      };
    }
  ).files.items.find((item) => item.path === "long.bin");
  expect(binary?.after).toMatchObject({ encoding: "base64", contentTruncated: true, bytes: 20000 });
  expect(binary?.after.content).toHaveLength(16000);
  expect((full.plan as { hash: string }).hash).toBe(plan.hash);
});

it("requires exact evidence for declared reference roots without using unrelated installations", async () => {
  const referenceCode = code.replace(
    JSON.stringify(manifest),
    JSON.stringify({
      ...manifest,
      inputs: [...manifest.inputs, { root: "source", path: "common", capture: "listing" }],
    })
  );
  const { config, recipe, trust, root, file, before } = await fixture(referenceCode);
  const install = path.join(root, "source");
  await fs.mkdir(path.join(install, "launcher"), { recursive: true });
  await fs.mkdir(path.join(install, "game"));
  await fs.writeFile(
    path.join(install, "launcher/launcher-settings.json"),
    JSON.stringify({ rawVersion: "9.0.0" })
  );
  const result = await migrationReport(config, {
    operation: "migrate",
    action: "preview",
    recipeFile: recipe,
    trust,
    sourceGamePath: install,
  });
  expect(result).toMatchObject({
    prepared: false,
    references: { source: { detectedBuild: "9.0.0", expectedBuild: "1.0.0", status: "mismatch" } },
  });
  expect(lifecycle.workers).toHaveLength(1);
  expect(await fs.readFile(file)).toEqual(before);
  await fs.rm(path.join(install, "launcher/launcher-settings.json"));
  const unknown = await migrationReport(config, {
    operation: "migrate",
    action: "preview",
    recipeFile: recipe,
    trust,
    sourceGamePath: install,
  });
  expect(unknown).toMatchObject({
    prepared: false,
    references: { source: { detectedBuild: null, status: "unknown" } },
  });
  expect(unknown.blockedReasons).toContain(
    "Source installation exact build could not be verified from launcher metadata."
  );
  expect(lifecycle.workers).toHaveLength(2);
  await fs.writeFile(recipe, code);
  config.gamePath = install;
  const modOnly = await migrationReport(config, {
    operation: "migrate",
    action: "preview",
    recipeFile: recipe,
    trust: digest(Buffer.from(code)),
    answers: { confirm: true },
  });
  expect(modOnly).toMatchObject({ prepared: true, references: { target: { status: "unavailable" } } });
});

it("keeps a failed proposal blocked and preserves the author failure reason", async () => {
  const failing = code.replace(
    'const text = ctx.readText("mod", "common/test.txt");',
    'throw new Error("Fixture proposal failed"); const text = ctx.readText("mod", "common/test.txt");'
  );
  const { config, recipe, trust, file, before } = await fixture(failing);
  const result = await migrationReport(config, {
    operation: "migrate",
    action: "preview",
    recipeFile: recipe,
    trust,
    answers: { confirm: true },
  });
  expect(result).toMatchObject({ prepared: false, trustRequired: false });
  expect((result.blockedReasons as string[]).join("\n")).toContain("Fixture proposal failed");
  expect(result.plan).toBeUndefined();
  expect(await fs.readFile(file)).toEqual(before);
});

it.each(["version bytes", "metadata identity", "source alias"])(
  "rejects reference %s changed by inspection instead of returning stale build evidence",
  async (change) => {
    const requiredSource = code.replace(
      JSON.stringify(manifest),
      JSON.stringify({
        ...manifest,
        inputs: [...manifest.inputs, { root: "source", path: "common", capture: "listing" }],
      })
    );
    const { config, recipe, root, file, before } = await fixture(requiredSource);
    const installs = [path.join(root, "source-a"), path.join(root, "source-b")];
    const metadataBytes = JSON.stringify({ rawVersion: "1.0.0" });
    for (const install of installs) {
      await fs.mkdir(path.join(install, "game/common"), { recursive: true });
      await fs.mkdir(path.join(install, "launcher"));
      await fs.writeFile(path.join(install, "launcher/launcher-settings.json"), metadataBytes);
    }
    const alias = path.join(root, "selected-source");
    await fs.symlink(installs[0], alias, process.platform === "win32" ? "junction" : "dir");
    const metadata = path.join(installs[0], "launcher/launcher-settings.json");
    const request = {
      operation: "migrate" as const,
      action: "preview",
      recipeFile: recipe,
      sourceGamePath: alias,
      answers: { confirm: true },
    };
    const stable = await migrationReport(config, { ...request, trust: digest(Buffer.from(requiredSource)) });
    expect(stable).toMatchObject({
      prepared: true,
      references: {
        source: {
          detectedBuild: "1.0.0",
          status: "matches",
          metadata: { sha256: digest(Buffer.from(metadataBytes)) },
        },
      },
    });
    const mutation =
      change === "version bytes"
        ? `require("node:fs").writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({rawVersion:"9.0.0"}));`
        : change === "metadata identity"
          ? `require("node:fs").writeFileSync(${JSON.stringify(metadata + ".new")}, ${JSON.stringify(metadataBytes)}); require("node:fs").renameSync(${JSON.stringify(metadata + ".new")}, ${JSON.stringify(metadata)});`
          : `require("node:fs").unlinkSync(${JSON.stringify(alias)}); require("node:fs").symlinkSync(${JSON.stringify(installs[1])}, ${JSON.stringify(alias)}, process.platform === "win32" ? "junction" : "dir");`;
    const changedCode = requiredSource.replace("inspect() { return {", `inspect() { ${mutation} return {`);
    await fs.writeFile(recipe, changedCode);
    await expect(
      migrationReport(config, { ...request, trust: digest(Buffer.from(changedCode)) })
    ).rejects.toMatchObject({
      code: "stale_input",
      message: expect.stringContaining("reference installation or version metadata changed"),
    });
    expect(await fs.readFile(file)).toEqual(before);
    await expect(fs.access(path.join(config.mod, "long.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  }
);

it("terminates a trusted infinite loop on timeout and cancellation", async () => {
  const { config, recipe, trust, root, file, before } = await fixture(
    'require("node:fs").writeFileSync(__filename + ".entered", "entered"); while (true) {}'
  );
  config.timeoutMs = 100;
  await expect(
    migrationReport(config, { operation: "migrate", action: "catalog", recipeFile: recipe, trust })
  ).rejects.toMatchObject({ code: "migration_timeout" });
  config.timeoutMs = 30000;
  await fs.rm(recipe + ".entered", { force: true });
  const controller = new AbortController();
  const pending = migrationReport(
    config,
    { operation: "migrate", action: "catalog", recipeFile: recipe, trust },
    controller.signal
  );
  const rejection = expect(pending).rejects.toMatchObject({ code: "operation_cancelled" });
  const deadline = Date.now() + 10000;
  let entered = false;
  while (Date.now() < deadline && !entered) {
    try {
      await fs.access(recipe + ".entered");
      entered = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!entered) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  controller.abort();
  await rejection;
  expect(entered).toBe(true);
  expect(await fs.readFile(file)).toEqual(before);
  expect(await fs.readdir(root)).not.toContain("journal.json");
});
