import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseLoc } from "@px-lsp/server/parser";
import { resolveConfig, type Configuration } from "../src/config";
import type { PxtkRequest } from "../src/contract";
import { syncLocalization } from "../src/translation";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function save(config: Configuration, file: string, text: string) {
  const destination = path.join(config.mod, file);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, text);
  return destination;
}
async function fixture(game = "ck3") {
  await fs.mkdir(".local", { recursive: true });
  const mod = await fs.mkdtemp(path.resolve(".local/translation-test-"));
  roots.push(mod);
  const descriptor = game === "ck3" ? "descriptor.mod" : ".metadata/metadata.json";
  await fs.mkdir(path.dirname(path.join(mod, descriptor)), { recursive: true });
  await fs.writeFile(
    path.join(mod, descriptor),
    game === "ck3" ? 'name="Translation"' : '{"name":"Translation"}'
  );
  const config = await resolveConfig({
    cwd: mod,
    env: {},
    overrides: { game, mod, gamePath: null, logsPath: null },
  });
  expect(config.issues).toEqual([]);
  const request: PxtkRequest = {
    operation: "loc",
    action: "sync",
    sourceLanguage: "english",
    language: "german",
  };
  return { config, request };
}

it.each([
  ["ck3", ""],
  ["eu5", "in_game/"],
])("previews and applies blank %s counterparts in their profile roots", async (game, stage) => {
  const { config, request } = await fixture(game);
  const source = await save(
    config,
    `${stage}localization/english/sub/feature_l_english.yml`,
    '\uFEFF# Translator context\nl_english:\n feature_title:7 "A title"\n feature_desc:0 "Say \\"hi\\"" # original\n'
  );
  const before = await fs.readFile(source);
  const destination = path.join(config.mod, `${stage}localization/german/sub/feature_l_german.yml`);
  const preview = await syncLocalization(config, request);
  expect(preview).toMatchObject({
    mode: "preview",
    changed: 1,
    addedKeys: 2,
    sourceLanguage: "english",
    targetLanguage: "german",
  });
  await expect(fs.access(destination)).rejects.toThrow();
  await expect(syncLocalization(config, { ...request, write: true })).rejects.toMatchObject({
    code: "preview_required",
  });
  const result = await syncLocalization(config, {
    ...request,
    write: true,
    expect: String(preview.previewToken),
  });
  expect(result).toMatchObject({ mode: "written", written: [destination] });
  const text = await fs.readFile(destination, "utf8");
  expect(text.startsWith("\uFEFF# Translator context\nl_german:\n")).toBe(true);
  expect(text).toContain('feature_title:7 "" # english: A title');
  expect(parseLoc(text).entries.map((entry) => entry.value)).toEqual(["", ""]);
  expect(await fs.readFile(source)).toEqual(before);
  expect(await syncLocalization(config, request)).toMatchObject({ changed: 0, addedKeys: 0 });
});

it("preserves every existing target byte and appends missing keys with its EOL style", async () => {
  const { config, request } = await fixture();
  await save(
    config,
    "localization/english/feature_l_english.yml",
    '\uFEFFl_english:\n kept:0 "Source"\n new_key:3 "New text"\n'
  );
  const original = '\uFEFFl_german:\r\n # Keep this comment\r\n kept:9 "Uebersetzung" # retain\r\n\r\n \r\n';
  const destination = await save(config, "localization/german/feature_l_german.yml", original);
  const preview = await syncLocalization(config, request);
  expect(preview.addedKeys).toBe(1);
  await syncLocalization(config, { ...request, write: true, expect: String(preview.previewToken) });
  const text = await fs.readFile(destination, "utf8");
  expect(text.startsWith(original)).toBe(true);
  expect(text).toContain(' new_key:3 "" # english: New text\r\n');
  expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  expect(parseLoc(text).entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: "kept", version: 9, value: "Uebersetzung" })])
  );
});

it("preserves translations in other target files and supports selecting one source file", async () => {
  const { config, request } = await fixture();
  const selected = "localization/english/selected_l_english.yml";
  await save(config, selected, 'l_english:\n kept:0 "Source"\n selected_key:0 "Selected"\n');
  await save(config, "localization/english/other_l_english.yml", 'l_english:\n other_key:0 "Other"\n');
  const existing = await save(
    config,
    "localization/german/shared_l_german.yml",
    '\uFEFFl_german:\n kept:5 "Translated elsewhere"\n'
  );
  const bytes = await fs.readFile(existing);
  const preview = await syncLocalization(config, { ...request, file: selected });
  expect(preview.addedKeys).toBe(1);
  await syncLocalization(config, {
    ...request,
    file: selected,
    write: true,
    expect: String(preview.previewToken),
  });
  const destination = await fs.readFile(
    path.join(config.mod, "localization/german/selected_l_german.yml"),
    "utf8"
  );
  expect(parseLoc(destination).entries.map((entry) => entry.key)).toEqual(["selected_key"]);
  expect(await fs.readFile(existing)).toEqual(bytes);
  await expect(fs.access(path.join(config.mod, "localization/german/other_l_german.yml"))).rejects.toThrow();
});

it.each(["source", "target", "inventory"])(
  "refuses stale %s inputs without applying the preview",
  async (input) => {
    const { config, request } = await fixture();
    const source = await save(
      config,
      "localization/english/feature_l_english.yml",
      'l_english:\n fresh:0 "New"\n'
    );
    const target = await save(
      config,
      "localization/german/feature_l_german.yml",
      '\uFEFFl_german:\n old:0 "Keep"\n'
    );
    const preview = await syncLocalization(config, request);
    if (input === "inventory")
      await save(config, "localization/english/new_l_english.yml", 'l_english:\n another:0 "Later"\n');
    else await fs.appendFile(input === "source" ? source : target, " # concurrent edit\n");
    const before = await fs.readFile(target);
    await expect(
      syncLocalization(config, { ...request, write: true, expect: String(preview.previewToken) })
    ).rejects.toMatchObject({ code: "stale_preview" });
    expect(await fs.readFile(target)).toEqual(before);
  }
);

it.each(["source-entry", "source-files", "target-entry", "target-files"])(
  "rejects duplicate %s keys before writing",
  async (duplicate) => {
    const { config, request } = await fixture();
    await save(config, "localization/english/feature_l_english.yml", 'l_english:\n key:0 "Source"\n');
    await save(config, "localization/german/feature_l_german.yml", 'l_german:\n translated:0 "Target"\n');
    const source = duplicate.startsWith("source");
    const language = source ? "english" : "german";
    const name = duplicate.endsWith("files") ? "other" : "feature";
    await save(
      config,
      `localization/${language}/${name}_l_${language}.yml`,
      `l_${language}:\n ${source ? "key" : "translated"}:0 "First"\n${duplicate.endsWith("entry") ? ` ${source ? "key" : "translated"}:1 "Second"\n` : ""}`
    );
    await expect(syncLocalization(config, request)).rejects.toMatchObject({
      code: duplicate.endsWith("files") ? "ambiguous_localization" : "duplicate_localization",
    });
  }
);

it.each([
  "source-header",
  "target-header",
  "second-header",
  "malformed-entry",
  "generated-source",
  "generated-target",
])("refuses %s while preserving inputs", async (failure) => {
  const { config, request } = await fixture();
  const source = await save(
    config,
    "localization/english/feature_l_english.yml",
    `${failure === "generated-source" ? "# Generated by source tool\n" : ""}${failure === "source-header" ? "l_french" : "l_english"}:\n key:0 "Source"\n${failure === "second-header" ? "l_english:\n" : ""}${failure === "malformed-entry" ? " broken:0 no_quotes\n" : ""}`
  );
  const target = await save(
    config,
    "localization/german/feature_l_german.yml",
    `${failure === "generated-target" ? "# Do not edit this generated file\n" : ""}${failure === "target-header" ? "l_french" : "l_german"}:\n existing:0 "Keep"\n`
  );
  const before = await fs.readFile(target);
  await expect(syncLocalization(config, request)).rejects.toMatchObject({
    code: failure.startsWith("generated")
      ? "generated_localization"
      : failure === "malformed-entry"
        ? "invalid_localization"
        : "invalid_header",
  });
  expect(await fs.readFile(target)).toEqual(before);
  expect(await fs.readFile(source)).not.toEqual(Buffer.alloc(0));
});

it("rejects invalid language selection, sources outside the mod and non-localization paths", async () => {
  const { config, request } = await fixture();
  await expect(syncLocalization(config, { ...request, sourceLanguage: "german" })).rejects.toMatchObject({
    code: "invalid_languages",
  });
  await expect(syncLocalization(config, { ...request, language: undefined })).rejects.toMatchObject({
    code: "invalid_languages",
  });
  await expect(
    syncLocalization(config, { ...request, file: "../outside_l_english.yml" })
  ).rejects.toMatchObject({ code: "outside_mod" });
  await save(config, "misc_l_english.yml", 'l_english:\n key:0 "Source"\n');
  await expect(syncLocalization(config, { ...request, file: "misc_l_english.yml" })).rejects.toMatchObject({
    code: "invalid_loc_file",
  });
});
