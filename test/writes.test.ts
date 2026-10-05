import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveConfig } from "../src/config";
import { finishChanges } from "../src/writes";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  await fs.mkdir(".local/testing", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/testing/pxtk-write-boundary-"));
  roots.push(root);
  const outer = path.join(root, "outer");
  const mod = path.join(outer, "mod");
  const parent = path.join(root, "parent");
  await fs.mkdir(mod, { recursive: true });
  await fs.mkdir(parent);
  await fs.writeFile(path.join(mod, "descriptor.mod"), 'name="Fixture"');
  const config = await resolveConfig({
    cwd: mod,
    env: {},
    overrides: { game: "ck3", mod, gamePath: null, logsPath: null, parents: [parent] },
  });
  expect(config.issues).toEqual([]);
  return { outer, mod, parent, config };
}

it.each(["root", "ancestor"])("rejects a %s junction replacement after preview", async (boundary) => {
  const { outer, mod, parent, config } = await fixture();
  const changes = [{ file: path.join(mod, "probe.txt"), before: null, after: Buffer.from("new") }];
  const preview = await finishChanges(config, { operation: "format" }, changes);
  const replacement = boundary === "root" ? mod : outer;
  if (boundary === "ancestor") await fs.mkdir(path.join(parent, "mod"));
  await fs.rename(replacement, replacement + "-old");
  await fs.symlink(parent, replacement, process.platform === "win32" ? "junction" : "dir");
  try {
    await expect(
      finishChanges(
        config,
        { operation: "format", write: true, expect: String(preview.previewToken) },
        changes
      )
    ).rejects.toMatchObject({ code: "linked_destination" });
    await expect(
      fs.access(path.join(parent, ...(boundary === "ancestor" ? ["mod"] : []), "probe.txt"))
    ).rejects.toThrow();
  } finally {
    await fs.unlink(replacement);
  }
});

it("rechecks the canonical read-only roots after configuration resolution", async () => {
  const { mod, parent, config } = await fixture();
  const changes = [{ file: path.join(mod, "probe.txt"), before: null, after: Buffer.from("new") }];
  const preview = await finishChanges(config, { operation: "format" }, changes);
  await fs.rename(parent, parent + "-old");
  await fs.symlink(mod, parent, process.platform === "win32" ? "junction" : "dir");
  try {
    await expect(
      finishChanges(
        config,
        { operation: "format", write: true, expect: String(preview.previewToken) },
        changes
      )
    ).rejects.toMatchObject({ code: "read_only_source" });
    await expect(fs.access(path.join(mod, "probe.txt"))).rejects.toThrow();
  } finally {
    await fs.unlink(parent);
  }
});

it.each([1, 2])("reports a changed source after a commit in a %i-file write", async (count) => {
  const { mod, config } = await fixture();
  const source = path.join(mod, "source.txt");
  await fs.writeFile(source, "original source");
  const changes = Array.from({ length: count }, (_, index) => ({
    file: path.join(mod, `output-${index}.txt`),
    before: Buffer.from("before"),
    after: Buffer.from("after"),
  }));
  for (const change of changes) await fs.writeFile(change.file, change.before);
  const inputs = [{ file: source, bytes: Buffer.from("original source") }];
  const preview = await finishChanges(config, { operation: "format" }, changes, inputs);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    await actual.rename(from, to);
    await fs.writeFile(source, "concurrent edit");
  });
  await expect(
    finishChanges(
      config,
      {
        operation: "format",
        write: true,
        expect: String(preview.previewToken),
      },
      changes,
      inputs
    )
  ).rejects.toMatchObject({
    code: "write_failed",
    message: expect.stringContaining("Completed files: " + JSON.stringify([changes[0].file])),
  });
  expect(await fs.readFile(source, "utf8")).toBe("concurrent edit");
  expect(await fs.readFile(changes[0].file, "utf8")).toBe("after");
  if (count === 2) expect(await fs.readFile(changes[1].file, "utf8")).toBe("before");
  expect((await fs.readdir(mod)).some((name) => name.startsWith(".pxtk-"))).toBe(false);
});

it("allows owned updates and creations that are also captured inputs", async () => {
  const { mod, config } = await fixture();
  const changes = [
    { file: path.join(mod, "existing.txt"), before: Buffer.from("before"), after: Buffer.from("after") },
    { file: path.join(mod, "new.txt"), before: null, after: Buffer.from("created") },
  ];
  await fs.writeFile(changes[0].file, "before");
  const inputs = changes.map((change) => ({ file: change.file, bytes: change.before }));
  const preview = await finishChanges(config, { operation: "format" }, changes, inputs);
  expect(
    await finishChanges(
      config,
      {
        operation: "format",
        write: true,
        expect: String(preview.previewToken),
      },
      changes,
      inputs
    )
  ).toMatchObject({ mode: "written", written: changes.map((change) => change.file) });
  for (const change of changes) expect(await fs.readFile(change.file)).toEqual(change.after);
});
