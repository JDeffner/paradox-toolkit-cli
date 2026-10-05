import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { responseSchema } from "../src/responses";
import type { PxtkOperation } from "../src/contract";

const exec = promisify(execFile);
const command = path.resolve("dist/pxtk.cjs");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => !entry[0].startsWith("PX_") && entry[1] !== undefined
  )
);
let scratch: string;
let serial = 0;
type Body = {
  operation: PxtkOperation;
  status: string;
  data: Record<string, unknown>;
  error?: { code: string };
};
type Fixture = { mod: string; parent: string; game: string; output: string; operations: string };

async function fixture(): Promise<Fixture> {
  const root = path.join(scratch, `fixture-${++serial}`);
  const mod = path.join(root, "mod");
  const parent = path.join(root, "parent");
  const game = path.join(root, "game");
  for (const directory of [mod, parent, game]) await fs.mkdir(directory, { recursive: true });
  const write = async (base: string, relative: string, text: string) => {
    const file = path.join(base, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  for (const [folder, name] of [
    [mod, "Workflow mod"],
    [parent, "Workflow parent"],
  ])
    await write(
      folder,
      "descriptor.mod",
      `\uFEFFname="${name}"\nversion="1.0"\nsupported_version="*"\ntags={ "Gameplay" }\n`
    );
  await write(
    mod,
    ".px-toolkit/pxtk.json",
    JSON.stringify({ game: "ck3", gamePath: game, parents: [parent], logsPath: null, tigerPath: null })
  );
  await write(
    mod,
    "common/scripted_effects/rename.txt",
    "\uFEFFentry_target = { add_gold = 1 }\nentry_caller = { entry_target = yes }\n"
  );
  await write(
    mod,
    "common/scripted_effects/edit.txt",
    "\uFEFF# keep this comment\nedit_target = { add_gold = 1 }\nneighbor = { }\n"
  );
  await write(mod, "common/scripted_effects/shared.txt", "\uFEFFshared = { add_gold = 2 }\n");
  await write(parent, "common/scripted_effects/shared.txt", "\uFEFFshared = { add_gold = 1 }\n");
  await write(
    mod,
    "localization/english/entry_l_english.yml",
    '\uFEFFl_english:\n entry_text:0 "Source text"\n'
  );
  await write(mod, ".vscode/settings.json", "{}");
  await write(game, "common/scripted_effects/import.txt", "\uFEFFvanilla_import = { }\n");
  await write(game, "common/scripted_effects/stale.txt", "\uFEFFvanilla_stale = { }\n");
  const operations = path.join(root, "edits.json");
  await fs.writeFile(
    operations,
    JSON.stringify([
      { op: "setProperties", name: "edit_target", properties: [{ key: "add_gold", value: "3" }] },
    ])
  );
  return { mod, parent, game, output: path.join(root, "release"), operations };
}

async function run(f: Fixture, ...args: string[]) {
  let result: { code?: number; stdout: string; stderr: string };
  try {
    result = await exec(process.execPath, [command, ...args, "--json"], {
      cwd: f.mod,
      env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    result = error as { code: number; stdout: string; stderr: string };
    if (!result.stdout) throw error;
  }
  expect(result.stderr).toBe("");
  const body = JSON.parse(result.stdout) as Body;
  if (!body.error) responseSchema(body.operation).parse(body);
  return { code: result.code ?? 0, body };
}
function token(body: Body): string {
  expect(body.data.previewToken).toMatch(/^[a-f0-9]{64}$/);
  return body.data.previewToken as string;
}
function items(body: Body, key: string): Record<string, unknown>[] {
  return (body.data[key] as { items: Record<string, unknown>[] }).items;
}
async function recipe(f: Fixture) {
  const file = path.join(f.mod, ".px-toolkit/fixture.cjs");
  const code = `module.exports={manifest:{id:'fixture.setting',revision:'1',sdkVersion:1,gameId:'ck3',fromVersion:'1.0.0',toVersion:'1.1.0',kind:'recipe',detection:'script',requirement:'required',title:'Fixture',description:'Test fixture',guidance:'Fixture only',limitations:['No runtime verification'],dependsOn:[],evidence:['Synthetic fixture'],inputs:[{root:'mod',path:'common'}]},inspect(){return {applicability:'applicable',findings:[],questions:[],coverage:['Fixture only']};},prepare(ctx){const text=ctx.readText('mod','common/test.txt');const start=text.indexOf('yes');return {groups:[{id:'setting',title:'Setting',dependsOn:[],changes:[{kind:'text',path:'common/test.txt',edits:[{start,end:start+3,text:'no'}]}]}],checks:[],unresolved:[]};}};`;
  await fs.writeFile(file, code);
  await fs.writeFile(path.join(f.mod, "common/test.txt"), "\uFEFFsetting = yes\n");
  return { file, trust: createHash("sha256").update(code).digest("hex") };
}
beforeAll(async () => {
  await fs.access(command);
  await fs.mkdir(path.resolve(".local"), { recursive: true });
  scratch = await fs.mkdtemp(path.resolve(".local/workflow-entry-"));
});
afterAll(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});

describe("new workflows through CLI and stdio MCP", () => {
  it("synchronizes a language only after reviewing the CLI preview", async () => {
    const f = await fixture();
    const args = ["loc", "sync", "--source-language", "english", "--language", "german"];
    const target = path.join(f.mod, "localization/german/entry_l_german.yml");
    const preview = await run(f, ...args);
    expect(preview.body.data.mode).toBe("preview");
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await run(f, ...args, "--write")).body.error?.code).toBe("preview_required");
    expect((await run(f, ...args, "--write", "--expect", token(preview.body))).body.data.mode).toBe(
      "written"
    );
    const bytes = await fs.readFile(target);
    expect(bytes.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(bytes.toString("utf8")).toContain('entry_text:0 ""');
    expect(bytes.toString("utf8")).toContain("Source text");
  });
  it("renames the declaration and its caller through the CLI provider", async () => {
    const f = await fixture();
    const args = [
      "rename",
      "--file",
      "common/scripted_effects/rename.txt",
      "--line",
      "1",
      "--column",
      "1",
      "--to",
      "entry_renamed",
    ];
    const file = path.join(f.mod, "common/scripted_effects/rename.txt");
    const original = await fs.readFile(file);
    const preview = await run(f, ...args);
    expect(preview.body.data.mode).toBe("preview");
    expect(await fs.readFile(file)).toEqual(original);
    expect((await run(f, ...args, "--write", "--expect", token(preview.body))).body.data.mode).toBe(
      "written"
    );
    expect(await fs.readFile(file, "utf8")).toBe(
      "\uFEFFentry_renamed = { add_gold = 1 }\nentry_caller = { entry_renamed = yes }\n"
    );
  });
  it("rejects a stale CLI edit and then applies a fresh precise edit", async () => {
    const f = await fixture();
    const args = ["edit", "--file", "common/scripted_effects/edit.txt", "--operations", f.operations];
    const file = path.join(f.mod, "common/scripted_effects/edit.txt");
    const preview = await run(f, ...args);
    const changed = (await fs.readFile(file, "utf8")) + "# concurrent edit\n";
    await fs.writeFile(file, changed);
    const stale = await run(f, ...args, "--write", "--expect", token(preview.body));
    expect(stale).toMatchObject({ code: 2, body: { error: { code: "stale_preview" } } });
    expect(await fs.readFile(file, "utf8")).toBe(changed);
    const fresh = await run(f, ...args);
    expect((await run(f, ...args, "--write", "--expect", token(fresh.body))).body.data.mode).toBe("written");
    expect(await fs.readFile(file, "utf8")).toBe(changed.replace("add_gold = 1", "add_gold = 3"));
  });
  it("reports explicit ordered CLI conflict inputs with bounded output", async () => {
    const f = await fixture();
    const result = await run(f, "conflicts", "--input", f.parent, "--input", f.mod, "--limit", "1");
    expect(result.body.data).toMatchObject({
      supported: true,
      sourceCount: 2,
      inputOrder: "first-loaded-first",
    });
    const conflict = items(result.body, "conflicts")[0];
    expect(conflict.name).toBe("shared");
    expect(conflict.winner).toBeTypeOf("string");
    expect(conflict.contributors).toMatchObject({ total: 2, truncated: true });
  });
  it("imports unchanged vanilla bytes and refuses a stale source token", async () => {
    const f = await fixture();
    const args = ["import", "--source", "common/scripted_effects/import.txt"];
    const preview = await run(f, ...args);
    const target = path.join(f.mod, "common/scripted_effects/import.txt");
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await run(f, ...args, "--write", "--expect", token(preview.body))).body.data.mode).toBe(
      "written"
    );
    expect(await fs.readFile(target)).toEqual(
      await fs.readFile(path.join(f.game, "common/scripted_effects/import.txt"))
    );
    const staleArgs = ["import", "--source", "common/scripted_effects/stale.txt"];
    const stalePreview = await run(f, ...staleArgs);
    await fs.appendFile(path.join(f.game, "common/scripted_effects/stale.txt"), "# changed\n");
    expect(
      (await run(f, ...staleArgs, "--write", "--expect", token(stalePreview.body))).body.error?.code
    ).toBe("stale_preview");
    await expect(fs.access(path.join(f.mod, "common/scripted_effects/stale.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("stages a clean local CLI release while leaving source files unchanged", async () => {
    const f = await fixture();
    const args = ["package", "--output", f.output];
    const preview = await run(f, ...args);
    expect(preview.body.data).toMatchObject({ mode: "preview", ready: true });
    await expect(fs.access(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(items(preview.body, "excluded").map((row) => row.file)).toContain(".px-toolkit/");
    const written = await run(f, ...args, "--write", "--expect", token(preview.body));
    expect(written.body.data.mode).toBe("written");
    expect(await fs.readFile(path.join(f.output, "descriptor.mod"))).toEqual(
      await fs.readFile(path.join(f.mod, "descriptor.mod"))
    );
    await expect(fs.access(path.join(f.output, ".vscode"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.access(path.join(f.mod, ".vscode/settings.json"));
  });
  it("discovers exact-build migration routes through the CLI", async () => {
    const f = await fixture();
    const catalog = await run(f, "migrate", "catalog");
    const first = items(catalog.body, "catalog")[0];
    expect(first.id).toBeTypeOf("string");
    const routes = await run(
      f,
      "migrate",
      "routes",
      "--from",
      String(first.fromVersion),
      "--to",
      String(first.toVersion)
    );
    expect(items(routes.body, "routes").length).toBeGreaterThan(0);
    expect(routes.body.data.gameplayTested).toBe(false);
  });
  it("loads a trusted local recipe in the bundled worker and previews without applying", async () => {
    const f = await fixture();
    const local = await recipe(f);
    const untrusted = await run(f, "migrate", "catalog", "--recipe-file", local.file);
    expect(untrusted).toMatchObject({ code: 2, body: { data: { trustRequired: true } } });
    const preview = await run(
      f,
      "migrate",
      "preview",
      "--recipe",
      "fixture.setting",
      "--recipe-file",
      local.file,
      "--trust",
      local.trust
    );
    expect(preview.body.data).toMatchObject({ prepared: true, gameplayTested: false });
    const plan = preview.body.data.plan as { files: { items: { after: { content: string } }[] } };
    expect(plan.files.items[0].after.content).toBe("\uFEFFsetting = no\n");
    expect(await fs.readFile(path.join(f.mod, "common/test.txt"), "utf8")).toBe("\uFEFFsetting = yes\n");
  });
  it("exposes all new workflows with valid output through real SDK MCP calls", async () => {
    const f = await fixture();
    const client = new Client({ name: "workflow-entry", version: "1" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [command, "mcp"],
          cwd: f.mod,
          env,
          stderr: "pipe",
        })
      );
      const tools = await client.listTools();
      for (const name of ["loc", "rename", "edit", "conflicts", "import", "package", "migrate"])
        expect(tools.tools.find((tool) => tool.name === `pxtk_${name}`)?.outputSchema?.type).toBe("object");
      const call = async (operation: PxtkOperation, args: Record<string, unknown>) => {
        const result = await client.callTool({ name: `pxtk_${operation}`, arguments: args });
        expect(result.isError).toBeUndefined();
        const body = result.structuredContent as unknown as Body;
        responseSchema(operation).parse(body);
        expect(result.content).toContainEqual({ type: "text", text: JSON.stringify(body) });
        return body;
      };
      const sync = await call("loc", { action: "sync", sourceLanguage: "english", language: "german" });
      expect(sync.data.mode).toBe("preview");
      expect(
        (
          await call("rename", {
            file: "common/scripted_effects/rename.txt",
            line: 1,
            column: 1,
            to: "mcp_renamed",
          })
        ).data.mode
      ).toBe("preview");
      const edits = [
        { op: "setProperties", name: "edit_target", properties: [{ key: "add_gold", value: "4" }] },
      ];
      const args = { file: "common/scripted_effects/edit.txt", edits };
      const edit = await call("edit", args);
      const refused = await client.callTool({ name: "pxtk_edit", arguments: { ...args, write: true } });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ error: { code: "preview_required" } });
      expect((await call("edit", { ...args, write: true, expect: token(edit) })).data.mode).toBe("written");
      expect((await call("conflicts", { inputs: [f.parent, f.mod] })).data.sourceCount).toBe(2);
      expect((await call("import", { source: "common/scripted_effects/import.txt" })).data.mode).toBe(
        "preview"
      );
      expect((await call("package", { output: f.output })).data.ready).toBe(true);
      const catalog = await call("migrate", { action: "catalog" });
      expect(items(catalog, "catalog").length).toBeGreaterThan(0);
      const local = await recipe(f);
      expect(
        (
          await call("migrate", {
            action: "preview",
            recipe: "fixture.setting",
            recipeFile: local.file,
            trust: local.trust,
          })
        ).data.prepared
      ).toBe(true);
      await expect(fs.access(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
    }
  });
});
