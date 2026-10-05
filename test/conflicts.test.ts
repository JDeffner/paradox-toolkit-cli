import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gameMetas } from "@px-lsp/server/games/metaRegistry";
import { reportConflicts } from "../src/conflicts";
import type { Configuration } from "../src/config";
import type { PxtkRequest } from "../src/contract";

let scratch: string;
let serial = 0;
async function mod(name: string, files: Record<string, string>, descriptor = "") {
  const root = path.join(scratch, `mod-${++serial}`);
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "descriptor.mod"), `\uFEFFname="${name}"\n${descriptor}`);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "\uFEFF" + content);
  }
  return root;
}
function config(root: string, parents: string[] = [], game = "ck3"): Configuration {
  return {
    game,
    meta: gameMetas[game],
    mod: root,
    parents,
    gamePath: null,
    logsPath: null,
    tigerPath: null,
    tigerConfig: null,
    configFile: null,
    language: "english",
    timeoutMs: 30_000,
    issues: [],
  };
}
function request(inputs?: string[], limit = 20): PxtkRequest {
  return { operation: "conflicts", ...(inputs ? { inputs } : {}), limit };
}
type Entry = {
  name: string;
  winner: string | null;
  state: string;
  explanation: string;
  contributors: {
    items: { id: string; sourceName: string; active: boolean }[];
    total: number;
    truncated: boolean;
  };
  issues: { items: string[] };
};
type Report = {
  supported: boolean;
  sourceFingerprint: string | null;
  sourceCount: number;
  fileCount: number;
  conflicts: { items: Entry[]; total: number; truncated: boolean };
  issues: { items: string[] };
  inputs: { name: string; replacePaths: { items: string[] } }[];
  coverage: {
    savedFilesOnly: boolean;
    gameplayTested: boolean;
    policyRevision: string | null;
    limits: string[];
  };
};
async function report(cfg: Configuration, inputs?: string[], limit = 20) {
  return (await reportConflicts(cfg, request(inputs, limit))) as unknown as Report;
}
beforeAll(async () => {
  await fs.mkdir(path.resolve(".local"), { recursive: true });
  scratch = await fs.mkdtemp(path.resolve(".local/conflicts-test-"));
});
afterAll(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});

describe("ordered mod conflict report", () => {
  it("uses saved ordered inputs and changes the same-file winner when their order changes", async () => {
    const file = "common/scripted_effects/shared.txt";
    const a = await mod("A", { [file]: "shared = { add_gold = 1 }\n" });
    const b = await mod("B", { [file]: "shared = { add_gold = 2 }\n" });
    const forward = await report(config(b, [a]));
    const backward = await report(config(b), [b, a]);
    const winnerName = (result: Report) => {
      const entry = result.conflicts.items.find((item) => item.name === "shared")!;
      return entry.contributors.items.find((item) => item.id === entry.winner)?.sourceName;
    };
    expect(winnerName(forward)).toBe("B");
    expect(winnerName(backward)).toBe("A");
    expect(forward.inputs.map((input) => input.name)).toEqual(["A", "B"]);
    expect(forward.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(backward.sourceFingerprint).not.toBe(forward.sourceFingerprint);
    expect(forward.sourceCount).toBe(2);
    expect(forward.fileCount).toBe(2);
    expect(forward.coverage).toMatchObject({ savedFilesOnly: true, gameplayTested: false });
    expect(await fs.readdir(scratch)).toEqual([path.basename(a), path.basename(b)]);
    expect(await fs.readFile(path.join(a, file), "utf8")).toBe("\uFEFFshared = { add_gold = 1 }\n");
  });

  it("keeps cross-file unknown winners and replace_path effects explicit", async () => {
    const a = await mod("A", { "common/scripted_effects/a.txt": "shared = { }\n" });
    const b = await mod(
      "B",
      { "common/scripted_effects/b.txt": "shared = { add_gold = 1 }\n" },
      'replace_path="common/scripted_effects"\ndependencies={ "A" "Missing" }\n'
    );
    const result = await report(config(a), [b, a]);
    const entry = result.conflicts.items.find((item) => item.name === "shared")!;
    expect(entry.winner).toBeNull();
    expect(entry.issues.items.join("\n")).toContain("replace_path");
    expect(result.inputs[0].replacePaths.items).toEqual(["common/scripted_effects"]);
    expect(result.issues.items.join("\n")).toContain("appears later");
    expect(result.issues.items.join("\n")).toContain('"Missing" is missing');
    const withoutReplace = await mod("C", { "common/scripted_effects/c.txt": "shared = { }\n" });
    expect((await report(config(a), [a, withoutReplace])).conflicts.items[0].winner).toBeNull();
  });

  it("bounds entries and contributor lists while retaining complete counts", async () => {
    const file = "common/scripted_effects/shared.txt";
    const a = await mod("A", { [file]: "one = { }\ntwo = { }\n" });
    const b = await mod("B", { [file]: "one = { add_gold = 1 }\ntwo = { add_gold = 2 }\n" });
    const result = await report(config(b), [a, b], 1);
    expect(result.conflicts).toMatchObject({ total: 2, truncated: true });
    expect(result.conflicts.items).toHaveLength(1);
    expect(result.conflicts.items[0].contributors).toMatchObject({ total: 2, truncated: true });
    expect(result.conflicts.items[0].contributors.items).toHaveLength(1);
  });

  it("does not describe a provisional same-file winner as effective when replace_path makes it unknown", async () => {
    const file = "common/scripted_effects/shared.txt";
    const a = await mod("A", { [file]: "shared = { add_gold = 1 }\n" });
    const b = await mod(
      "B",
      { [file]: "shared = { add_gold = 2 }\n" },
      'replace_path="common/scripted_effects"\n'
    );
    const result = await report(config(b), [a, b]);
    const entry = result.conflicts.items.find((item) => item.name === "shared")!;
    expect(entry.winner).toBeNull();
    expect(entry.explanation).not.toContain("Effective contribution: B.");
    expect(entry.explanation).toContain("No proven effective contribution.");
    expect(entry.explanation).toContain("1 contribution(s) suppressed by whole-file shadowing.");
    expect(entry.issues.items.join("\n")).toContain("replace_path");
    expect(entry.contributors.items.map((contributor) => contributor.active)).toEqual([false, true]);
  });

  it("reports binary review and changes the fingerprint when saved sources change", async () => {
    const root = await mod("A", { "common/scripted_effects/a.txt": "one = { }\n" });
    await fs.mkdir(path.join(root, "gfx"));
    await fs.writeFile(path.join(root, "gfx/texture.dds"), Buffer.from([0, 1, 2]));
    const before = await report(config(root));
    expect(before.issues.items.join("\n")).toContain("Binary file requires external review");
    await fs.writeFile(path.join(root, "common/scripted_effects/a.txt"), "\uFEFFone = { add_gold = 1 }\n");
    expect((await report(config(root))).sourceFingerprint).not.toBe(before.sourceFingerprint);
  });

  it("does not substitute another game's rules when its profile is unsupported", async () => {
    const root = await mod("A", {});
    await fs.mkdir(path.join(root, ".metadata"));
    await fs.writeFile(path.join(root, ".metadata/metadata.json"), JSON.stringify({ name: "A" }));
    const result = await report(config(root, [], "vic3"));
    expect(result.supported).toBe(false);
    expect(result.coverage.policyRevision).toBeNull();
    expect(result.sourceFingerprint).toBeNull();
    expect(result.issues.items.join("\n")).toContain("No verified composition policy");
  });

  it("rejects invalid, duplicate, overlapping and linked inputs", async () => {
    const root = await mod("A", {});
    await expect(report(config(root), [])).rejects.toMatchObject({ code: "invalid_inputs" });
    await expect(report(config(root), Array(201).fill(root))).rejects.toMatchObject({
      code: "invalid_inputs",
    });
    await expect(report(config(root), [root, path.join(root, ".")])).rejects.toMatchObject({
      code: "invalid_inputs",
    });
    await expect(report(config(root), [root, scratch])).rejects.toMatchObject({ code: "invalid_inputs" });
    const missing = path.join(scratch, "missing-descriptor");
    await fs.mkdir(missing);
    await expect(report(config(root), [missing])).rejects.toMatchObject({ code: "conflict_scan_failed" });
    const linked = path.join(scratch, "linked-root");
    await fs.symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(report(config(root), [linked])).rejects.toMatchObject({ code: "invalid_inputs" });
    await fs.mkdir(path.join(root, "common"));
    await fs.symlink(
      missing,
      path.join(root, "common/escaped"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await expect(report(config(root))).rejects.toMatchObject({ code: "conflict_scan_failed" });
  });
});
