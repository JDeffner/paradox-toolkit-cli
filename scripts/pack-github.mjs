// Mirror the tested npm tarball without rebuilding or changing shipped files.
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const tarball = process.argv[2];
if (!tarball) throw new Error("Usage: node scripts/pack-github.mjs <cli.tgz> [output-directory]");
const root = path.resolve(import.meta.dirname, "..");
const stagingRoot = path.join(root, ".local/packaging");
const output = path.resolve(process.argv[3] ?? path.join(root, ".local/artifacts/github"));
await mkdir(stagingRoot, { recursive: true });
const staging = await mkdtemp(path.join(stagingRoot, "github-"));
try {
  // Relative tar arguments also work with Windows' non-Unicode system tar.
  await copyFile(path.resolve(tarball), path.join(staging, "payload.tgz"));
  execFileSync("tar", ["-xzf", "payload.tgz"], { cwd: staging });
  const pkg = path.join(staging, "package");
  const manifestPath = path.join(pkg, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, "pxtk-cli");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.bin.pxtk, "dist/pxtk.cjs");
  manifest.name = "@jdeffner/pxtk-cli";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  execSync("pnpm --config.ignore-scripts=true pack --out ../mirror.tgz", {
    cwd: pkg,
    stdio: "pipe",
    windowsHide: true,
  });

  // Repacking must preserve the complete file set and all non-manifest bytes.
  const check = path.join(staging, "check");
  await mkdir(check);
  execFileSync("tar", ["-xzf", "../mirror.tgz"], { cwd: check });
  const packed = path.join(check, "package");
  const files = async (directory) =>
    (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
      .sort();
  const sourceFiles = await files(pkg);
  assert.deepEqual(await files(packed), sourceFiles, "Mirror changed the package file set.");
  for (const file of sourceFiles) {
    if (file === "package.json") {
      assert.deepEqual(JSON.parse(await readFile(path.join(packed, file), "utf8")), manifest);
    } else {
      assert.deepEqual(
        await readFile(path.join(packed, file)),
        await readFile(path.join(pkg, file)),
        `Mirror changed ${file}.`
      );
    }
  }
  await mkdir(output, { recursive: true });
  const target = path.join(output, `jdeffner-pxtk-cli-${manifest.version}.tgz`);
  await copyFile(path.join(staging, "mirror.tgz"), target);
  console.log(`Created ${path.relative(root, target)}`);
} finally {
  assert.equal(path.dirname(staging), stagingRoot);
  await rm(staging, { recursive: true, force: true });
}
