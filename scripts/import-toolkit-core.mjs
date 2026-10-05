import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { packageDigest } from "./toolkit-package-digest.mjs";

const checkout = process.argv[2];
const pnpm = process.env.npm_execpath;
if (!checkout || !pnpm) {
  throw new Error("Usage: pnpm core:import <toolkit-checkout>");
}
const root = path.resolve(import.meta.dirname, "..");
const source = await realpath(checkout);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const dirty = execFileSync(
  "git",
  [
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--",
    "packages/protocol",
    "packages/server",
    "scripts/bake-browser-data.ts",
    "scripts/build-migrations.mjs",
    "tsconfig.base.json",
  ],
  { cwd: source, encoding: "utf8" }
).trim();
if (dirty) throw new Error(`Commit shared-core changes before taking a pinned snapshot:\n${dirty}`);
await mkdir(path.join(root, ".local"), { recursive: true });
const scratch = await mkdtemp(path.join(root, ".local/toolkit-import-"));
const packages = [];
for (const name of ["protocol", "server"]) {
  const cwd = path.join(source, "packages", name);
  const metadata = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  if (metadata.name !== `@px-lsp/${name}`) throw new Error(`Unexpected package in ${cwd}`);
  console.log(`Packing ${metadata.name}@${metadata.version} from ${revision.slice(0, 12)}...`);
  try {
    execFileSync(process.execPath, [pnpm, "pack", "--pack-destination", scratch], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Packing ${metadata.name} failed:\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, {
      cause: error,
    });
  }
  const archive = `px-lsp-${name}-${metadata.version}.tgz`;
  const bytes = await readFile(path.join(scratch, archive));
  const unpacked = path.join(scratch, name);
  await mkdir(unpacked);
  execFileSync("tar", ["-xzf", `../${archive}`], { cwd: unpacked, windowsHide: true });
  packages.push({
    name: metadata.name,
    version: metadata.version,
    archive: `${name}.tgz`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentSha256: await packageDigest(path.join(unpacked, "package")),
    packed: archive,
  });
}
const target = path.join(root, "vendor/toolkit-core");
await mkdir(target, { recursive: true });
for (const item of packages) {
  await copyFile(path.join(scratch, item.packed), path.join(target, item.archive));
}
await writeFile(
  path.join(target, "manifest.json"),
  JSON.stringify(
    {
      repository: "https://github.com/JDeffner/paradox-modding-toolkit.git",
      revision,
      packages: packages.map(({ name, version, archive, sha256, contentSha256 }) => ({
        name,
        version,
        archive,
        sha256,
        contentSha256,
      })),
    },
    null,
    2
  ) + "\n"
);
console.log("Imported Toolkit packages. Run pnpm install, then compile, typecheck, lint and test.");
