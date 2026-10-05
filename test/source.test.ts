import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveConfig, type Configuration } from "../src/config";
import { readSource } from "../src/files";
import { readSourcePage, type SourceReadRequest } from "../src/source";

const roots: string[] = [];
async function fixture(text = "test = yes\n") {
  await fs.mkdir(".local/testing", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/testing/pxtk-source-"));
  roots.push(root);
  const mod = path.join(root, "mod");
  await fs.mkdir(mod);
  await fs.writeFile(path.join(mod, "descriptor.mod"), 'name="test"');
  const file = path.join(mod, "source.txt");
  await fs.writeFile(file, text);
  const config = await resolveConfig({
    cwd: mod,
    env: {},
    overrides: { game: "ck3", gamePath: null, logsPath: null },
  });
  return { root, mod, file, config };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("reports excerpt line omissions and reads the complete long definition", async () => {
  const text = Array.from({ length: 40 }, (_, line) => `field_${line} = yes`).join("\n");
  const { file, mod, config } = await fixture(text);
  const excerpt = await readSource(file, 5, [mod]);
  expect(excerpt).toMatchObject({
    file: await fs.realpath(file),
    line: 6,
    contextStart: 4,
    totalLines: 40,
    limits: { lineCount: 18, charsPerLine: 500 },
    truncated: true,
    omittedBefore: true,
    omittedAfter: true,
    next: { startLine: 22, startColumn: 1 },
  });
  expect(excerpt.context).toHaveLength(18);
  const whole = await readSourcePage(config, excerpt.continuation);
  expect(whole.text).toBe(text);
  expect(whole.next).toBeNull();
  expect(whole.truncated).toBe(false);
});

it("reports clipped lines with a continuation that exposes the omitted characters", async () => {
  const text = "x".repeat(750) + "\nlast = yes";
  const { file, mod, config } = await fixture(text);
  const excerpt = await readSource(file, 0, [mod]);
  expect(excerpt.context[0]).toHaveLength(500);
  expect(excerpt).toMatchObject({
    truncated: true,
    omittedBefore: false,
    omittedAfter: false,
    clippedLines: [{ line: 1, startColumn: 501, totalChars: 750 }],
    next: { startLine: 1, startColumn: 501 },
  });
  const remainder = await readSourcePage(config, {
    file,
    ...excerpt.next!,
    sourceHash: excerpt.sourceHash,
  });
  expect(excerpt.context[0] + remainder.text).toBe(text);
});

it("reconstructs exact decoded source across character and line pages", async () => {
  const text = "first\r\n\r\n" + "漢😀".repeat(250) + "\r\nlast\n";
  const { config } = await fixture("\uFEFF" + text);
  const request: SourceReadRequest = { file: "source.txt", lineCount: 2, maxChars: 7 };
  let reconstructed = "";
  for (let count = 0; count < 300; count++) {
    const page = await readSourcePage(config, request);
    expect(page.text.length).toBeLessThanOrEqual(7);
    expect(page.totalLines).toBe(5);
    expect(page.encoding).toBe("utf8-bom");
    reconstructed += page.text;
    if (!page.next) break;
    expect(page.text.length).toBeGreaterThan(0);
    Object.assign(request, page.next, { sourceHash: page.sourceHash });
  }
  expect(reconstructed).toBe(text);
});

it("rejects stale continuations when saved bytes change", async () => {
  const { file, config } = await fixture("one\ntwo\nthree");
  const page = await readSourcePage(config, { file, lineCount: 1 });
  await fs.writeFile(file, "one\nchanged\nthree");
  await expect(
    readSourcePage(config, { file, ...page.next!, sourceHash: page.sourceHash })
  ).rejects.toMatchObject({ code: "source_changed" });
});

it("validates ranges and accepts an empty source and final empty line", async () => {
  const { config, file } = await fixture("one\n");
  for (const range of [
    { startLine: 0 },
    { startLine: 3 },
    { startColumn: 5 },
    { startColumn: 0 },
    { lineCount: 201 },
    { lineCount: 0 },
    { maxChars: 64001 },
    { maxChars: 0 },
    { startLine: 1.5 },
  ]) {
    await expect(readSourcePage(config, { file, ...range })).rejects.toMatchObject({ code: "invalid_range" });
  }
  expect(await readSourcePage(config, { file, startLine: 2 })).toMatchObject({ text: "", next: null });
  await fs.writeFile(file, "");
  expect(await readSourcePage(config, { file })).toMatchObject({ text: "", totalLines: 1, truncated: false });
});

it("reads configured parents and game data but rejects the game install parent", async () => {
  const { root, config } = await fixture();
  const gamePath = path.join(root, "install/game");
  const parent = path.join(root, "dependency");
  await fs.mkdir(gamePath, { recursive: true });
  await fs.mkdir(parent);
  const permitted: Configuration = { ...config, gamePath, parents: [parent] };
  for (const dir of [gamePath, parent]) {
    const file = path.join(dir, "source.txt");
    await fs.writeFile(file, "allowed");
    expect((await readSourcePage(permitted, { file })).text).toBe("allowed");
  }
  const outside = path.join(root, "install/private.txt");
  await fs.writeFile(outside, "outside");
  await expect(readSourcePage(permitted, { file: outside })).rejects.toMatchObject({
    code: "outside_sources",
  });
  await expect(readSourcePage(permitted, { file: "../install/private.txt" })).rejects.toMatchObject({
    code: "outside_sources",
  });
});

it("rejects a directory link that escapes the configured source roots", async () => {
  const { root, mod, config } = await fixture();
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.txt"), "outside");
  await fs.symlink(outside, path.join(mod, "linked"), process.platform === "win32" ? "junction" : "dir");
  await expect(readSourcePage(config, { file: "linked/private.txt" })).rejects.toMatchObject({
    code: "outside_sources",
  });
  await expect(readSource(path.join(mod, "linked/private.txt"), 0, [mod])).rejects.toMatchObject({
    code: "outside_sources",
  });
});

it("rejects unsupported files, binary text and oversized files", async () => {
  const { mod, file, config } = await fixture();
  const binary = path.join(mod, "image.dds");
  await fs.writeFile(binary, "DDS header");
  await expect(readSourcePage(config, { file: binary })).rejects.toMatchObject({
    code: "unsupported_source",
  });
  await fs.writeFile(file, Buffer.from([0xff, 0xfe, 65, 0]));
  await expect(readSourcePage(config, { file })).rejects.toMatchObject({ code: "unsupported_source" });
  const handle = await fs.open(file, "w");
  await handle.truncate(16 * 1024 * 1024 + 1);
  await handle.close();
  await expect(readSourcePage(config, { file })).rejects.toMatchObject({ code: "source_too_large" });
});

it("uses the shared legacy text decoder and reports its encoding", async () => {
  const { file, config } = await fixture();
  await fs.writeFile(file, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  expect(await readSourcePage(config, { file })).toMatchObject({ text: "café", encoding: "latin1-fallback" });
});
