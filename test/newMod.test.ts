import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateDescriptor } from "@px-lsp/protocol/descriptorMod";
import { METADATA_REL_PATH } from "@px-lsp/protocol/descriptorMetadata";
import { resolveConfig } from "../src/config";
import { createMod } from "../src/newMod";
import type { PxtkRequest } from "../src/contract";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), mkdir: vi.fn(actual.mkdir) };
});

const roots: string[] = [];
async function fixture(game = "ck3", existing = false) {
  await fs.mkdir(".local/testing", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/testing/pxtk-new-"));
  roots.push(root);
  const destination = path.join(root, "new mod");
  if (existing) await fs.mkdir(destination);
  const config = await resolveConfig({
    cwd: root,
    creatingMod: true,
    overrides: { game, mod: destination, gamePath: null, logsPath: null },
    env: {},
  });
  const request: PxtkRequest = {
    operation: "new",
    output: destination,
    name: "New Mod",
    supportedVersion: "1.20.*",
  };
  return { root, destination, config, request };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it.each([
  ["ck3", "descriptor.mod", "common/on_action", "localization/english"],
  ["vic3", METADATA_REL_PATH, "common/on_actions", "localization/english"],
  ["eu5", METADATA_REL_PATH, "in_game/common/scripted_effects", "main_menu"],
])(
  "creates a portable %s mod with the game's descriptor and folders",
  async (game, descriptor, folder, loc) => {
    const { root, destination, config, request } = await fixture(game);
    expect(config.issues).toEqual([]);
    const preview = await createMod(config, request);
    expect(preview.mode).toBe("preview");
    expect(preview.folders).toEqual(expect.arrayContaining([folder, loc]));
    expect(await fs.readdir(root)).toEqual([]);
    const applied = await createMod(config, {
      ...request,
      write: true,
      expect: String(preview.previewToken),
    });
    expect(applied.mode).toBe("written");
    expect(applied.written).toHaveLength(2);
    expect((await fs.stat(path.join(destination, folder))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(destination, loc))).isDirectory()).toBe(true);
    const text = await fs.readFile(path.join(destination, descriptor), "utf8");
    if (descriptor === "descriptor.mod") {
      expect((await fs.readFile(path.join(destination, descriptor))).subarray(0, 3)).toEqual(
        Buffer.from([0xef, 0xbb, 0xbf])
      );
      expect(
        validateDescriptor(text, { isDescriptorFile: true }).filter((issue) => issue.severity === "error")
      ).toEqual([]);
      expect(text).toContain('name="New Mod"');
      expect(text).toContain('supported_version="1.20.*"');
      expect(text).not.toContain("path=");
    } else {
      expect(JSON.parse(text)).toMatchObject({
        name: "New Mod",
        id: "new_mod",
        supported_game_version: "1.20.*",
      });
      expect(applied.nextSteps).toEqual(expect.arrayContaining([expect.stringContaining("thumbnail.png")]));
    }
    const portable = JSON.parse(await fs.readFile(path.join(destination, ".px-toolkit/pxtk.json"), "utf8"));
    expect(portable).toEqual({ game, mod: ".", language: "english" });
    const loaded = await resolveConfig({
      cwd: path.join(destination, folder),
      overrides: { gamePath: null, logsPath: null },
      env: {},
    });
    expect(loaded.mod).toBe(await fs.realpath(destination));
    expect(loaded.issues).toEqual([]);
    expect(applied.launcherRegistered).toBe(false);
    expect(await fs.readdir(root)).toEqual(["new mod"]);
  }
);

it("allows an existing empty directory and requires its preview token for writing", async () => {
  const { destination, config, request } = await fixture("ck3", true);
  await expect(createMod(config, { ...request, write: true })).rejects.toMatchObject({
    code: "preview_required",
  });
  expect(await fs.readdir(destination)).toEqual([]);
  const preview = await createMod(config, request);
  await createMod(config, { ...request, write: true, expect: String(preview.previewToken) });
  expect(await fs.readFile(path.join(destination, "descriptor.mod"), "utf8")).toContain('name="New Mod"');
});

it("rejects stale options and a changed destination state without creating files", async () => {
  const { destination, config, request } = await fixture();
  const preview = await createMod(config, request);
  await expect(
    createMod(config, {
      ...request,
      name: "Another Mod",
      write: true,
      expect: String(preview.previewToken),
    })
  ).rejects.toMatchObject({ code: "stale_preview" });
  await fs.mkdir(destination);
  await expect(
    createMod(config, {
      ...request,
      write: true,
      expect: String(preview.previewToken),
    })
  ).rejects.toMatchObject({ code: "stale_preview" });
  expect(await fs.readdir(destination)).toEqual([]);
});

it("preserves arbitrary existing content and descriptor collisions", async () => {
  const { destination, config, request } = await fixture("ck3", true);
  const preview = await createMod(config, request);
  const descriptor = path.join(destination, "descriptor.mod");
  await fs.writeFile(descriptor, "user work");
  await expect(
    createMod(config, {
      ...request,
      write: true,
      expect: String(preview.previewToken),
    })
  ).rejects.toMatchObject({ code: "destination_not_empty" });
  expect(await fs.readFile(descriptor, "utf8")).toBe("user work");
  expect(await fs.readdir(destination)).toEqual(["descriptor.mod"]);
});

it("rejects links in the destination and its ancestors, including dangling links", async () => {
  const { root, destination, config, request } = await fixture();
  await fs.symlink(path.join(root, "absent"), destination, process.platform === "win32" ? "junction" : "dir");
  await expect(createMod(config, request)).rejects.toMatchObject({ code: "linked_destination" });
  await fs.rm(destination);
  const actual = path.join(root, "actual");
  await fs.mkdir(actual);
  const linked = path.join(root, "linked");
  await fs.symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
  const mod = path.join(linked, "child");
  const linkedConfig = await resolveConfig({
    creatingMod: true,
    overrides: { game: "ck3", mod, gamePath: null, logsPath: null },
    env: {},
  });
  await expect(createMod(linkedConfig, { ...request, output: mod })).rejects.toMatchObject({
    code: "linked_destination",
  });
  expect(await fs.readdir(actual)).toEqual([]);
});

it("keeps vanilla and dependency roots read-only for absent destinations", async () => {
  const { root, request } = await fixture();
  const source = path.join(root, "source");
  await fs.mkdir(source);
  for (const boundary of [{ gamePath: source }, { parents: [source] }]) {
    const mod = path.join(source, "child");
    const config = await resolveConfig({
      creatingMod: true,
      overrides: { game: "ck3", mod, gamePath: null, logsPath: null, ...boundary },
      env: {},
    });
    expect(config.issues.join(" ")).toContain("read-only source overlap");
    await expect(createMod(config, { ...request, output: mod })).rejects.toMatchObject({
      code: "invalid_workspace",
    });
  }
  expect(await fs.readdir(source)).toEqual([]);
});

it("does not inherit configuration from the source mod when creating a new mod", async () => {
  const { root, destination } = await fixture();
  await fs.mkdir(path.join(root, ".px-toolkit"));
  await fs.writeFile(
    path.join(root, ".px-toolkit/pxtk.json"),
    JSON.stringify({
      game: "vic3",
      mod: ".",
      language: "german",
      parents: ["missing dependency"],
    })
  );
  const config = await resolveConfig({
    cwd: root,
    creatingMod: true,
    env: {},
    overrides: { game: "ck3", mod: destination, gamePath: null, logsPath: null },
  });
  expect(config.configFile).toBeNull();
  expect(config.parents).toEqual([]);
  expect(config.language).toBe("english");
  expect(config.issues).toEqual([]);
});

it("uses the installed version when known and reports an unknown version honestly", async () => {
  const { root, config, request } = await fixture();
  const unknown = await createMod(config, { ...request, supportedVersion: undefined });
  expect(unknown.supportedVersion).toBe("*");
  expect(unknown.nextSteps).toEqual(expect.arrayContaining([expect.stringContaining("version is unknown")]));
  const install = path.join(root, "installation");
  const game = path.join(install, "game");
  await fs.mkdir(game, { recursive: true });
  await fs.mkdir(path.join(install, "launcher"));
  await fs.writeFile(
    path.join(install, "launcher/launcher-settings.json"),
    JSON.stringify({ rawVersion: "1.20.0.3" })
  );
  expect(
    (await createMod({ ...config, gamePath: game }, { ...request, supportedVersion: undefined }))
      .supportedVersion
  ).toBe("1.20.*");
});

it("reports write failures and retains completed work", async () => {
  const { destination, config, request } = await fixture();
  const preview = await createMod(config, request);
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.writeFile)
    .mockImplementationOnce(original.writeFile)
    .mockRejectedValueOnce(new Error("disk full"));
  await expect(
    createMod(config, {
      ...request,
      write: true,
      expect: String(preview.previewToken),
    })
  ).rejects.toMatchObject({
    code: "write_failed",
    message: expect.stringContaining("disk full\nCompleted files:"),
  });
  expect(await fs.readFile(path.join(destination, "descriptor.mod"), "utf8")).toContain('name="New Mod"');
  await expect(fs.access(path.join(destination, ".px-toolkit/pxtk.json"))).rejects.toThrow();
});

it("stops when user content appears during creation and preserves it", async () => {
  const { destination, config, request } = await fixture("ck3", true);
  const preview = await createMod(config, request);
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.mkdir).mockImplementationOnce(async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await original.mkdir(...args);
    await original.writeFile(path.join(destination, "notes.txt"), "concurrent user work");
    return result;
  });
  await expect(
    createMod(config, {
      ...request,
      write: true,
      expect: String(preview.previewToken),
    })
  ).rejects.toMatchObject({
    code: "write_failed",
    message: expect.stringContaining("Destination gained content"),
  });
  expect(await fs.readFile(path.join(destination, "notes.txt"), "utf8")).toBe("concurrent user work");
  await expect(fs.access(path.join(destination, "descriptor.mod"))).rejects.toThrow();
});

it("rejects invalid descriptor input, missing parents, and cancellation without mutation", async () => {
  const { root, destination, config, request } = await fixture();
  await expect(createMod(config, { ...request, name: "Name\npath=bad" })).rejects.toMatchObject({
    code: "invalid_name",
  });
  await expect(createMod(config, { ...request, supportedVersion: '1.20"' })).rejects.toMatchObject({
    code: "invalid_version",
  });
  const mod = path.join(destination, "child");
  await expect(createMod({ ...config, mod }, { ...request, output: mod })).rejects.toMatchObject({
    code: "invalid_destination",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(createMod(config, request, controller.signal)).rejects.toThrow();
  expect(await fs.readdir(root)).toEqual([]);
});

it("rejects a trailing backslash in .mod names while JSON metadata escapes it", async () => {
  const ck3 = await fixture("ck3");
  await expect(createMod(ck3.config, { ...ck3.request, name: "Unsafe\\" })).rejects.toMatchObject({
    code: "invalid_name",
    message: expect.stringContaining("backslashes"),
  });
  expect(await fs.readdir(ck3.root)).toEqual([]);
  const vic3 = await fixture("vic3");
  const preview = await createMod(vic3.config, { ...vic3.request, name: "Safe\\" });
  const files = preview.files as Array<{ file: string; content: string }>;
  const metadata = files.find((file) => file.file === METADATA_REL_PATH)!;
  expect(JSON.parse(metadata.content).name).toBe("Safe\\");
});
