import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scaffoldDescriptor } from "@px-lsp/protocol/descriptorMod";
import { digest, resolveConfig } from "../src/config";
import type { PxtkRequest } from "../src/contract";
import { importVanilla } from "../src/importing";
import { packageMod } from "../src/packaging";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: vi.fn(original.mkdir),
    writeFile: vi.fn(original.writeFile),
    open: vi.fn(original.open),
  };
});
const roots: string[] = [];
async function fixture(game = "ck3") {
  await fs.mkdir(".local", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/file-workflows-"));
  roots.push(root);
  const mod = path.join(root, "mod");
  const vanilla = path.join(root, "vanilla");
  const output = path.join(root, "release");
  await fs.mkdir(mod);
  await fs.mkdir(path.join(vanilla, "events"), { recursive: true });
  const descriptor = game === "ck3" ? "descriptor.mod" : ".metadata/metadata.json";
  await fs.mkdir(path.dirname(path.join(mod, descriptor)), { recursive: true });
  await fs.writeFile(
    path.join(mod, descriptor),
    game === "ck3"
      ? "\uFEFF" + scaffoldDescriptor("Release", "1.20.*")
      : JSON.stringify({ name: "Release", id: "release", supported_game_version: "1.20.*", tags: ["Events"] })
  );
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x00, 0x0d, 0x0a, 0x61]);
  await fs.writeFile(path.join(vanilla, "events/exact.txt"), bytes);
  const config = await resolveConfig({
    cwd: root,
    overrides: { game, mod, gamePath: vanilla, logsPath: null },
    env: {},
  });
  expect(config.issues).toEqual([]);
  return { root, mod, vanilla, output, descriptor, bytes, config };
}
function request(operation: "import" | "package", extra: Partial<PxtkRequest> = {}): PxtkRequest {
  return { operation, ...extra };
}
function apply(input: PxtkRequest, preview: Record<string, unknown>): PxtkRequest {
  return { ...input, write: true, expect: String(preview.previewToken) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(original.open);
  for (const root of roots.splice(0)) await fs.rm(root, { force: true, recursive: true });
});

it("previews an exact vanilla file and copies raw bytes without changing vanilla", async () => {
  const { mod, vanilla, config, bytes } = await fixture();
  const input = request("import", { source: "events/exact.txt" });
  const preview = await importVanilla(config, input);
  expect(preview.mode).toBe("preview");
  expect(preview.files).toEqual([
    {
      file: "events/exact.txt",
      action: "create",
      beforeSha256: null,
      afterSha256: digest(bytes),
      bytes: bytes.length,
    },
  ]);
  await expect(fs.access(path.join(mod, "events"))).rejects.toThrow();
  await expect(importVanilla(config, { ...input, write: true })).rejects.toMatchObject({
    code: "preview_required",
  });
  await importVanilla(config, apply(input, preview));
  expect(await fs.readFile(path.join(mod, "events/exact.txt"))).toEqual(bytes);
  expect(await fs.readFile(path.join(vanilla, "events/exact.txt"))).toEqual(bytes);
});
it("creates the vanilla directory path without enumerating or copying its contents", async () => {
  const { config, mod, vanilla } = await fixture();
  await fs.mkdir(path.join(vanilla, "events/sub"));
  await fs.writeFile(path.join(vanilla, "events/sub/hidden.txt"), "unchanged");
  const input = request("import", { directory: "events/sub" });
  const preview = await importVanilla(config, input);
  expect(preview.files).toEqual([]);
  await importVanilla(config, apply(input, preview));
  expect(await fs.readdir(path.join(mod, "events/sub"))).toEqual([]);
  expect(await fs.readFile(path.join(vanilla, "events/sub/hidden.txt"), "utf8")).toBe("unchanged");
});
it.each([
  "../outside.txt",
  "/events/exact.txt",
  "C:/events/exact.txt",
  "events/../exact.txt",
  "events/.. /exact.txt",
  "events/exact.txt:stream",
])("refuses unsafe vanilla source %s", async (source) => {
  const { config } = await fixture();
  await expect(importVanilla(config, request("import", { source }))).rejects.toMatchObject({
    code: "invalid_source",
  });
});
it("rejects absent, wrong-kind, ambiguous, existing, and read-only import paths", async () => {
  const { config, mod, vanilla, bytes } = await fixture();
  await expect(importVanilla(config, request("import", { source: "absent.txt" }))).rejects.toMatchObject({
    code: "invalid_source",
  });
  await expect(importVanilla(config, request("import", { source: "events" }))).rejects.toMatchObject({
    code: "invalid_source",
  });
  await expect(
    importVanilla(config, request("import", { directory: "events/exact.txt" }))
  ).rejects.toMatchObject({ code: "invalid_source" });
  await expect(
    importVanilla(config, request("import", { directory: "events", source: "events/exact.txt" }))
  ).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(
    importVanilla({ ...config, parents: [mod] }, request("import", { source: "events/exact.txt" }))
  ).rejects.toMatchObject({ code: "read_only_source" });
  await fs.mkdir(path.join(mod, "events"));
  await fs.writeFile(path.join(mod, "events/exact.txt"), "user work");
  await expect(
    importVanilla(config, request("import", { source: "events/exact.txt" }))
  ).rejects.toMatchObject({ code: "destination_exists" });
  expect(await fs.readFile(path.join(mod, "events/exact.txt"), "utf8")).toBe("user work");
  expect(await fs.readFile(path.join(vanilla, "events/exact.txt"))).toEqual(bytes);
});
it("rejects stale vanilla content and replaced target ancestors", async () => {
  const { config, mod, vanilla } = await fixture();
  const input = request("import", { source: "events/exact.txt" });
  const preview = await importVanilla(config, input);
  await fs.writeFile(path.join(vanilla, "events/exact.txt"), "new source");
  await expect(importVanilla(config, apply(input, preview))).rejects.toMatchObject({ code: "stale_preview" });
  const fresh = await importVanilla(config, input);
  await fs.mkdir(path.join(mod, "events"));
  await expect(importVanilla(config, apply(input, fresh))).rejects.toMatchObject({ code: "stale_preview" });
  expect(await fs.readdir(path.join(mod, "events"))).toEqual([]);
});
it("refuses source and target links, including links that stay within their root", async () => {
  const { root, config, mod, vanilla } = await fixture();
  const type = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(path.join(vanilla, "events"), path.join(vanilla, "linked"), type);
  await expect(
    importVanilla(config, request("import", { source: "linked/exact.txt" }))
  ).rejects.toMatchObject({ code: "linked_path" });
  await fs.mkdir(path.join(root, "target"));
  await fs.symlink(path.join(root, "target"), path.join(mod, "events"), type);
  await expect(
    importVanilla(config, request("import", { source: "events/exact.txt" }))
  ).rejects.toMatchObject({ code: "linked_destination" });
  expect(await fs.readdir(path.join(root, "target"))).toEqual([]);
});
it("stages byte-identical content, applies defaults, and preserves source and ignored files", async () => {
  const { config, mod, output, descriptor, bytes } = await fixture();
  await fs.mkdir(path.join(mod, "events"));
  await fs.writeFile(path.join(mod, "events/content.txt"), bytes);
  await fs.writeFile(path.join(mod, "AGENTS.md"), "private tooling");
  await fs.mkdir(path.join(mod, ".px-toolkit"));
  await fs.writeFile(path.join(mod, ".px-toolkit/private.txt"), "private config");
  const input = request("package", { output });
  const preview = await packageMod(config, input);
  expect(preview).toMatchObject({ mode: "preview", totalFiles: 2, ready: true });
  expect(preview.excluded).toMatchObject({
    items: expect.arrayContaining([
      { file: "AGENTS.md", reason: ".pxignore policy" },
      { file: ".px-toolkit/", reason: "toolkit configuration" },
    ]),
  });
  await expect(fs.access(output)).rejects.toThrow();
  await expect(fs.access(path.join(mod, ".pxignore"))).rejects.toThrow();
  await packageMod(config, apply(input, preview));
  expect(await fs.readFile(path.join(output, "events/content.txt"))).toEqual(bytes);
  expect(await fs.readFile(path.join(output, descriptor))).toEqual(
    await fs.readFile(path.join(mod, descriptor))
  );
  expect(await fs.readFile(path.join(mod, "AGENTS.md"), "utf8")).toBe("private tooling");
  await expect(fs.access(path.join(output, ".px-toolkit"))).rejects.toThrow();
});
it("uses full custom gitignore semantics, mandatory descriptors, and bounded output", async () => {
  const { config, mod, output, descriptor } = await fixture("vic3");
  await fs.writeFile(path.join(mod, ".pxignore"), "*.txt\n!keep.txt\n.metadata/\n!.px-toolkit/\n");
  await fs.writeFile(path.join(mod, "skip.txt"), "excluded");
  await fs.writeFile(path.join(mod, "keep.txt"), "included");
  await fs.writeFile(path.join(mod, "AGENTS.md"), "custom policy includes this");
  await fs.mkdir(path.join(mod, config.meta.legacyConfigDirName!));
  await fs.writeFile(path.join(mod, config.meta.legacyConfigDirName!, "private.txt"), "excluded config");
  const input = request("package", { output, limit: 1 });
  const preview = await packageMod(config, input);
  expect(preview.included).toMatchObject({ total: 3, truncated: true, items: expect.any(Array) });
  expect((preview.included as { items: unknown[] }).items).toHaveLength(1);
  await packageMod(config, apply(input, preview));
  expect(await fs.readFile(path.join(output, "keep.txt"), "utf8")).toBe("included");
  expect(await fs.readFile(path.join(output, "AGENTS.md"), "utf8")).toBe("custom policy includes this");
  expect(await fs.readFile(path.join(output, descriptor))).toEqual(
    await fs.readFile(path.join(mod, descriptor))
  );
  await expect(fs.access(path.join(output, "skip.txt"))).rejects.toThrow();
  await expect(fs.access(path.join(output, config.meta.legacyConfigDirName!))).rejects.toThrow();
});
it("reports invalid metadata and prevents staging errors", async () => {
  const { config, mod, output, descriptor } = await fixture("vic3");
  await fs.writeFile(path.join(mod, descriptor), "{broken");
  const input = request("package", { output });
  const preview = await packageMod(config, input);
  expect(preview.ready).toBe(false);
  expect(preview.findings).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ level: "error", message: expect.stringContaining("Invalid metadata") }),
    ]),
  });
  await expect(packageMod(config, apply(input, preview))).rejects.toMatchObject({
    code: "package_not_ready",
  });
  await expect(fs.access(output)).rejects.toThrow();
});
it("rejects stale package files, ignore policies, existing destinations, and output overlap", async () => {
  const { root, config, mod, vanilla, output } = await fixture();
  const input = request("package", { output });
  const preview = await packageMod(config, input);
  await fs.writeFile(path.join(mod, "new.txt"), "new content");
  await expect(packageMod(config, apply(input, preview))).rejects.toMatchObject({ code: "stale_preview" });
  const fresh = await packageMod(config, input);
  await fs.writeFile(path.join(mod, ".pxignore"), "new.txt");
  await expect(packageMod(config, apply(input, fresh))).rejects.toMatchObject({ code: "stale_preview" });
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, "user.txt"), "preserved");
  await expect(packageMod(config, input)).rejects.toMatchObject({ code: "destination_exists" });
  expect(await fs.readFile(path.join(output, "user.txt"), "utf8")).toBe("preserved");
  for (const destination of [root, path.join(mod, "release"), path.join(vanilla, "release")])
    await expect(packageMod(config, { ...input, output: destination })).rejects.toMatchObject({
      code: "read_only_source",
    });
  await expect(
    packageMod(config, { ...input, output: path.join(root, "missing/release") })
  ).rejects.toMatchObject({ code: "invalid_destination" });
});
it("refuses packaging source links and output ancestor links", async () => {
  const { root, config, mod, output } = await fixture();
  await fs.link(path.join(mod, "descriptor.mod"), path.join(mod, "linked.mod"));
  await expect(packageMod(config, request("package", { output }))).rejects.toMatchObject({
    code: "linked_path",
  });
  await fs.unlink(path.join(mod, "linked.mod"));
  const linked = path.join(root, "linked");
  await fs.symlink(mod, linked, process.platform === "win32" ? "junction" : "dir");
  await expect(
    packageMod(config, request("package", { output: path.join(linked, "release") }))
  ).rejects.toMatchObject({ code: "linked_path" });
});
it.runIf(process.platform === "win32")(
  "refuses Windows path aliases that resolve inside source folders",
  async () => {
    const { root, config } = await fixture();
    await expect(
      packageMod(config, request("package", { output: path.join(root, "vanilla. ", "release") }))
    ).rejects.toThrow();
    await expect(fs.access(path.join(config.gamePath!, "release"))).rejects.toThrow();
  }
);
it("stops package copying if a source changes during staging and keeps completed files", async () => {
  const { config, mod, output } = await fixture();
  await fs.writeFile(path.join(mod, "later.txt"), "original");
  const input = request("package", { output });
  const preview = await packageMod(config, input);
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.mkdir).mockImplementationOnce(async (...args) => {
    const result = await original.mkdir(...args);
    await original.writeFile(path.join(mod, "later.txt"), "changed during staging");
    return result;
  });
  await expect(packageMod(config, apply(input, preview))).rejects.toMatchObject({
    code: "write_failed",
    message: expect.stringContaining("Mod source changed"),
  });
  expect(await fs.readFile(path.join(mod, "later.txt"), "utf8")).toBe("changed during staging");
  expect(await fs.readFile(path.join(output, "descriptor.mod"))).toEqual(
    await fs.readFile(path.join(mod, "descriptor.mod"))
  );
  await expect(fs.access(path.join(output, "later.txt"))).rejects.toThrow();
});

it.each(["import", "package"] as const)(
  "reports the partial %s file and closes its handle when cancelled",
  async (operation) => {
    const { config, mod, output, vanilla, bytes } = await fixture();
    if (operation === "package") {
      await fs.mkdir(path.join(mod, "events"));
      await fs.writeFile(path.join(mod, "events/exact.txt"), bytes);
    }
    const input = request(operation, operation === "import" ? { source: "events/exact.txt" } : { output });
    const run = operation === "import" ? importVanilla : packageMod;
    const preview = await run(config, input);
    const target = path.join(operation === "import" ? mod : output, "events/exact.txt");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const controller = new AbortController();
    let failedHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await original.open(...args);
      if (args[0] === target) {
        failedHandle = handle;
        const writeFile = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async (data, options) => {
          await handle.write(bytes.subarray(0, 2), 0, 2, 0);
          controller.abort();
          return writeFile(data, options);
        });
      }
      return handle;
    });
    await expect(run(config, apply(input, preview), controller.signal)).rejects.toMatchObject({
      code: "write_failed",
      message: expect.stringContaining("Partial files: " + JSON.stringify([target])),
    });
    expect(failedHandle?.fd).toBe(-1);
    expect(await fs.readFile(target)).toEqual(bytes.subarray(0, 2));
    expect(await fs.readFile(path.join(vanilla, "events/exact.txt"))).toEqual(bytes);
    if (operation === "package")
      expect(await fs.readFile(path.join(output, "descriptor.mod"))).toEqual(
        await fs.readFile(path.join(mod, "descriptor.mod"))
      );
  }
);

it.each(["import", "package"] as const)(
  "preserves changed %s content and reports its path when writing fails",
  async (operation) => {
    const { config, mod, output, vanilla, bytes } = await fixture();
    if (operation === "package") {
      await fs.mkdir(path.join(mod, "events"));
      await fs.writeFile(path.join(mod, "events/exact.txt"), bytes);
    }
    const input = request(operation, operation === "import" ? { source: "events/exact.txt" } : { output });
    const run = operation === "import" ? importVanilla : packageMod;
    const preview = await run(config, input);
    const target = path.join(operation === "import" ? mod : output, "events/exact.txt");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failedHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await original.open(...args);
      if (args[0] === target) {
        failedHandle = handle;
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          await handle.write(bytes.subarray(0, 2), 0, 2, 0);
          await original.writeFile(target, "concurrent user work");
          throw new Error("disk full");
        });
      }
      return handle;
    });
    await expect(run(config, apply(input, preview))).rejects.toMatchObject({
      code: "write_failed",
      message: expect.stringContaining("disk full"),
    });
    expect(failedHandle?.fd).toBe(-1);
    expect(await fs.readFile(target, "utf8")).toBe("concurrent user work");
    expect(await fs.readFile(path.join(vanilla, "events/exact.txt"))).toEqual(bytes);
  }
);
