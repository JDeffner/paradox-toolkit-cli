import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveConfig } from "../src/config";
import { finishChanges } from "../src/writes";

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
