import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { resolveConfig } from "../src/config";
import type { PxtkRequest } from "../src/contract";

const roots: string[] = [];
let bundleRoot: string;
let editing: typeof import("../src/editing");
beforeAll(async () => {
  await fs.mkdir(".local", { recursive: true });
  bundleRoot = await fs.mkdtemp(path.resolve(".local/editing-adapter-"));
  const bundle = path.join(bundleRoot, "editing.cjs");
  // Exercise the direct adapters with the actual packaged LSP, not a fake provider.
  await build({
    entryPoints: ["src/editing.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    define: { __dirname: JSON.stringify(path.resolve("dist")) },
  });
  editing = createRequire(import.meta.url)(bundle) as typeof import("../src/editing");
});
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  if (bundleRoot) await fs.rm(bundleRoot, { recursive: true, force: true });
});

async function fixture(text = "\uFEFFold_effect = { }\n", parents = false) {
  const root = await fs.mkdtemp(path.resolve(".local/editing-fixture-"));
  roots.push(root);
  const mod = path.join(root, "mod");
  const parent = path.join(root, "parent");
  for (const folder of [mod, ...(parents ? [parent] : [])]) {
    await fs.mkdir(path.join(folder, "common/scripted_effects"), { recursive: true });
    await fs.writeFile(path.join(folder, "descriptor.mod"), '\uFEFFname="Editing fixture"\n');
  }
  const file = path.join(mod, "common/scripted_effects/target.txt");
  await fs.writeFile(file, text);
  const config = await resolveConfig({
    cwd: mod,
    env: {},
    overrides: { game: "ck3", gamePath: null, logsPath: null, parents: parents ? [parent] : [] },
  });
  expect(config.issues).toEqual([]);
  const rename: PxtkRequest = { operation: "rename", file, line: 1, column: 1, to: "new_effect" };
  return { root, mod, parent, file, config, rename };
}

it("renames indexed declarations and callers while preserving comments, BOM and CRLF", async () => {
  const text = "\uFEFF# old_effect stays in this comment\r\nold_effect = { }\r\n";
  const f = await fixture(text);
  const caller = path.join(f.mod, "common/scripted_effects/caller.txt");
  const callText = "\uFEFFcaller = {\r\n\told_effect = yes # keep\r\n}\r\n";
  await fs.writeFile(caller, callText);
  const request = { ...f.rename, line: 2 };
  const preview = await editing.renameSymbol(f.config, request);
  expect(preview).toMatchObject({ mode: "preview", changed: 2, from: "old_effect", to: "new_effect" });
  expect(await fs.readFile(f.file, "utf8")).toBe(text);
  expect(await fs.readFile(caller, "utf8")).toBe(callText);
  const result = await editing.renameSymbol(f.config, {
    ...request,
    write: true,
    expect: String(preview.previewToken),
  });
  expect(result).toMatchObject({ mode: "written", changed: 2 });
  expect(await fs.readFile(f.file, "utf8")).toBe(text.replace("\r\nold_effect", "\r\nnew_effect"));
  expect(await fs.readFile(caller, "utf8")).toBe(callText.replace("old_effect =", "new_effect ="));
});

it("uses 1-based UTF-16 columns instead of Unicode code point columns", async () => {
  const text = 'unrelated = "\u{1f409}" old_effect = { }\n';
  const f = await fixture("\uFEFF" + text);
  const request = { ...f.rename, column: text.indexOf("old_effect") + 1 };
  const preview = await editing.renameSymbol(f.config, request);
  expect(preview.from).toBe("old_effect");
  expect(preview.edits).toMatchObject([{ edits: [{ start: text.indexOf("old_effect") }] }]);
});

it("renames a localization key from its indexed script reference without changing its value", async () => {
  const f = await fixture();
  const file = path.join(f.mod, "common/decisions/decision.txt");
  const loc = path.join(f.mod, "localization/english/probe_l_english.yml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.dirname(loc), { recursive: true });
  await fs.writeFile(file, "probe_decision = {\n title = old_title\n}\n");
  await fs.writeFile(loc, 'l_english:\r\n old_title:7 "Keep title" # keep\r\n');
  const request: PxtkRequest = { operation: "rename", file, line: 2, column: 10, to: "new_title" };
  const preview = await editing.renameSymbol(f.config, request);
  expect(preview.changed).toBe(2);
  expect(await fs.readFile(loc, "utf8")).not.toMatch(/^\uFEFF/);
  await editing.renameSymbol(f.config, { ...request, write: true, expect: String(preview.previewToken) });
  expect(await fs.readFile(loc, "utf8")).toBe('\uFEFFl_english:\r\n new_title:7 "Keep title" # keep\r\n');
  expect(await fs.readFile(file, "utf8")).toBe("\uFEFFprobe_decision = {\n title = new_title\n}\n");
});

it("renames from a localization declaration and preserves script and localization source", async () => {
  const f = await fixture();
  const file = path.join(f.mod, "common/decisions/decision.txt");
  const loc = path.join(f.mod, "localization/english/probe_l_english.yml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.dirname(loc), { recursive: true });
  const script = "\uFEFFprobe_decision = {\n title = old_title\n}\n";
  const localization = '\uFEFFl_english:\r\n old_title:7 "Keep title" # keep\r\n';
  await fs.writeFile(file, script);
  await fs.writeFile(loc, localization);
  const request: PxtkRequest = { operation: "rename", file: loc, line: 2, column: 2, to: "new_title" };
  const preview = await editing.renameSymbol(f.config, request);
  expect(preview).toMatchObject({ mode: "preview", changed: 2, from: "old_title", to: "new_title" });
  expect(await fs.readFile(file, "utf8")).toBe(script);
  expect(await fs.readFile(loc, "utf8")).toBe(localization);
  const result = await editing.renameSymbol(f.config, {
    ...request,
    write: true,
    expect: String(preview.previewToken),
  });
  expect(result).toMatchObject({ mode: "written", changed: 2 });
  expect(await fs.readFile(file, "utf8")).toBe(script.replace("title = old_title", "title = new_title"));
  expect(await fs.readFile(loc, "utf8")).toBe(localization.replace("old_title:7", "new_title:7"));
});

it("retains the provider's collision and foreign-definition refusals", async () => {
  const f = await fixture(undefined, true);
  const collision = path.join(f.mod, "common/scripted_effects/collision.txt");
  await fs.writeFile(collision, "\uFEFFnew_effect = { }\n");
  await expect(editing.renameSymbol(f.config, f.rename)).rejects.toMatchObject({ code: "rename_refused" });
  await fs.rm(collision);
  await fs.writeFile(path.join(f.parent, "common/scripted_effects/foreign.txt"), "\uFEFFold_effect = { }\n");
  await expect(editing.renameSymbol(f.config, f.rename)).rejects.toMatchObject({ code: "rename_refused" });
  expect(await fs.readFile(f.file, "utf8")).toBe("\uFEFFold_effect = { }\n");
});

it("retains ambiguity and unsupported symbol-type refusals", async () => {
  const f = await fixture();
  const trigger = path.join(f.mod, "common/scripted_triggers/target.txt");
  const untyped = path.join(f.mod, "untyped.txt");
  const gui = path.join(f.mod, "common/scripted_guis/probe.txt");
  for (const file of [trigger, gui]) await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(trigger, "\uFEFFold_effect = { }\n");
  await fs.writeFile(untyped, "\uFEFFold_effect = yes\n");
  await fs.writeFile(gui, "\uFEFFprobe_gui = { }\n");
  await expect(editing.renameSymbol(f.config, { ...f.rename, file: untyped })).rejects.toMatchObject({
    code: "rename_refused",
  });
  await expect(editing.renameSymbol(f.config, { ...f.rename, file: gui })).rejects.toMatchObject({
    code: "rename_refused",
  });
});

it("requires a preview and rejects new unrelated indexed inputs before applying rename", async () => {
  const f = await fixture();
  await expect(editing.renameSymbol(f.config, { ...f.rename, write: true })).rejects.toMatchObject({
    code: "preview_required",
  });
  const preview = await editing.renameSymbol(f.config, f.rename);
  await fs.writeFile(
    path.join(f.mod, "common/scripted_effects/unrelated.txt"),
    "\uFEFFunrelated_effect = { }\n"
  );
  await expect(
    editing.renameSymbol(f.config, { ...f.rename, write: true, expect: String(preview.previewToken) })
  ).rejects.toMatchObject({ code: "stale_preview" });
  expect(await fs.readFile(f.file, "utf8")).toBe("\uFEFFold_effect = { }\n");
});

it("edits definition properties surgically without reformatting surrounding source", async () => {
  const text =
    "\uFEFF# keep header\r\nold_effect = {\r\n  value = 1 # keep\r\n  remove = yes\r\n}\r\nsibling = { value = 7 } # keep sibling\r\n";
  const f = await fixture(text);
  const request: PxtkRequest = {
    operation: "edit",
    file: f.file,
    edits: [
      {
        op: "setProperties",
        name: "old_effect",
        properties: [
          { key: "value", value: "2" },
          { key: "remove", value: null },
        ],
      },
    ],
  };
  const preview = await editing.editDefinition(f.config, request);
  expect(preview).toMatchObject({ mode: "preview", changed: 1, ops: [{}] });
  expect(await fs.readFile(f.file, "utf8")).toBe(text);
  await editing.editDefinition(f.config, { ...request, write: true, expect: String(preview.previewToken) });
  expect(await fs.readFile(f.file, "utf8")).toBe(
    text.replace("value = 1", "value = 2").replace("  remove = yes\r\n", "")
  );
});

it("honors same-offset property insertions and ordered block upserts in the file's newline style", async () => {
  const f = await fixture("old_effect = {\r\n}\r\n");
  const request: PxtkRequest = {
    operation: "edit",
    file: f.file,
    edits: [
      { op: "setProperties", name: "old_effect", properties: [{ key: "first", value: "yes" }] },
      { op: "setProperties", name: "old_effect", properties: [{ key: "second", value: "no" }] },
      { op: "upsertBlock", name: "added", text: "added = {\n value = yes\n}" },
      { op: "upsertBlock", name: "last", text: "last = { }" },
    ],
  };
  const preview = await editing.editDefinition(f.config, request);
  await editing.editDefinition(f.config, { ...request, write: true, expect: String(preview.previewToken) });
  const text = await fs.readFile(f.file, "utf8");
  expect(text.startsWith("\uFEFFold_effect = {\r\n")).toBe(true);
  expect(text.indexOf("first = yes")).toBeLessThan(text.indexOf("second = no"));
  expect(text.indexOf("added = {")).toBeLessThan(text.indexOf("last = { }"));
  expect(text.replaceAll("\r\n", "")).not.toContain("\n");
});

it("refuses invalid source, conflicting operations and malformed replacement syntax without partial writes", async () => {
  const f = await fixture();
  const request: PxtkRequest = {
    operation: "edit",
    file: f.file,
    edits: [{ op: "upsertBlock", name: "old_effect", text: "old_effect = { }" }],
  };
  await fs.writeFile(f.file, "\uFEFFold_effect = {\n");
  await expect(editing.editDefinition(f.config, request)).rejects.toMatchObject({ code: "edit_refused" });
  await fs.writeFile(f.file, "\uFEFFold_effect = { value = 1 }\n");
  const before = await fs.readFile(f.file);
  await expect(
    editing.editDefinition(f.config, {
      ...request,
      edits: [
        ...request.edits!,
        { op: "setProperties", name: "old_effect", properties: [{ key: "value", value: "2" }] },
      ],
    })
  ).rejects.toMatchObject({ code: "edit_refused" });
  await expect(
    editing.editDefinition(f.config, {
      ...request,
      edits: [{ op: "upsertBlock", name: "old_effect", text: "old_effect = {" }],
    })
  ).rejects.toMatchObject({ code: "invalid_edit" });
  expect(await fs.readFile(f.file)).toEqual(before);
});

it("refuses outside-mod destinations, stale definition previews and out-of-range rename positions", async () => {
  const f = await fixture(undefined, true);
  const request: PxtkRequest = {
    operation: "edit",
    file: f.file,
    edits: [{ op: "setProperties", name: "old_effect", properties: [{ key: "value", value: "2" }] }],
  };
  await expect(editing.editDefinition(f.config, { ...request, write: true })).rejects.toMatchObject({
    code: "preview_required",
  });
  await expect(
    editing.editDefinition(f.config, { ...request, file: path.join(f.parent, "foreign.txt") })
  ).rejects.toMatchObject({ code: "outside_mod" });
  const preview = await editing.editDefinition(f.config, request);
  await fs.writeFile(path.join(f.parent, "common/scripted_effects/other.txt"), "\uFEFFother_effect = { }\n");
  await expect(
    editing.editDefinition(f.config, { ...request, write: true, expect: String(preview.previewToken) })
  ).rejects.toMatchObject({ code: "stale_preview" });
  await expect(editing.renameSymbol(f.config, { ...f.rename, column: 999 })).rejects.toMatchObject({
    code: "invalid_range",
  });
  expect(await fs.readFile(f.file, "utf8")).toBe("\uFEFFold_effect = { }\n");
});
