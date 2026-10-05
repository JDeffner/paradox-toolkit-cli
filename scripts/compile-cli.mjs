import { build } from "esbuild";
import { cp, mkdir, chmod, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";
import { packageDigest } from "./toolkit-package-digest.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const pkg = root;
const require = createRequire(import.meta.url);
const server = path.dirname(require.resolve("@px-lsp/server/package.json"));
const snapshotDir = path.join(root, "vendor/toolkit-core");
const snapshot = JSON.parse(await readFile(path.join(snapshotDir, "manifest.json"), "utf8"));
for (const item of snapshot.packages) {
  const bytes = await readFile(path.join(snapshotDir, item.archive));
  if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
    throw new Error(`Toolkit archive checksum mismatch: ${item.archive}`);
  }
  const installed = require(`${item.name}/package.json`);
  if (installed.version !== item.version) throw new Error(`Install the pinned ${item.name} package first.`);
  const installedRoot = path.dirname(require.resolve(`${item.name}/package.json`));
  if ((await packageDigest(installedRoot)) !== item.contentSha256) {
    throw new Error(`Installed ${item.name} differs from the pinned archive. Run pnpm install first.`);
  }
}
const dist = path.join(pkg, "dist");
if (path.dirname(dist) !== root || path.basename(dist) !== "dist")
  throw new Error("Invalid build output path.");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const cli = await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: path.join(dist, "pxtk.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  metafile: true,
  external: ["sharp"],
  banner: { js: "#!/usr/bin/env node" },
});
const lsp = await build({
  absWorkingDir: root,
  entryPoints: [require.resolve("@px-lsp/server/server")],
  outfile: path.join(dist, "lsp/server.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  metafile: true,
});
const migrations = await build({
  absWorkingDir: root,
  entryPoints: ["src/migrationWorker.ts"],
  outfile: path.join(dist, "migrations/worker.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  metafile: true,
});
await cp(path.join(server, "data"), path.join(dist, "data"), { recursive: true });
await cp(path.join(server, "media"), path.join(dist, "media"), { recursive: true });
await cp(path.join(server, "THIRD-PARTY-NOTICES.md"), path.join(dist, "lsp/THIRD-PARTY-NOTICES.md"));
await cp(path.join(snapshotDir, "manifest.json"), path.join(dist, "toolkit-core.json"));
// Ship license texts for every package whose code esbuild included, including
// transitive dependencies. Native sharp stays an installed runtime dependency.
const dependencies = new Map();
for (const file of [
  ...Object.keys(cli.metafile.inputs),
  ...Object.keys(lsp.metafile.inputs),
  ...Object.keys(migrations.metafile.inputs),
]) {
  if (!file.replaceAll("\\", "/").includes("node_modules/")) continue;
  let dir = path.dirname(path.resolve(root, file));
  while (dir !== path.dirname(dir)) {
    let metadata;
    try {
      metadata = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (metadata?.name) {
      dependencies.set(metadata.name, {
        dir,
        name: metadata.name,
        version: metadata.version,
        license: metadata.license,
      });
      break;
    }
    dir = path.dirname(dir);
  }
}
const licenses = path.join(dist, "licenses");
await mkdir(licenses, { recursive: true });
for (const dependency of dependencies.values()) {
  const files = (await readdir(dependency.dir)).filter((name) =>
    /^(license|licence|copying)([.-]|$)/i.test(name)
  );
  if (!files.length) throw new Error(`No license file for bundled dependency ${dependency.name}`);
  const target = path.join(licenses, dependency.name.replaceAll("/", "__"));
  await mkdir(target, { recursive: true });
  for (const file of files) await cp(path.join(dependency.dir, file), path.join(target, file));
}
await writeFile(
  path.join(licenses, "dependencies.json"),
  JSON.stringify(
    [...dependencies.values()].map(({ name, version, license }) => ({ name, version, license })),
    null,
    2
  ) + "\n"
);
await chmod(path.join(dist, "pxtk.cjs"), 0o755);
