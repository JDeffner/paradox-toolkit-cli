import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Hash package contents without package-manager dependency links. */
export async function packageDigest(directory) {
  const hash = createHash("sha256");
  async function visit(relative = "") {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!relative && entry.name === "node_modules") continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(directory, name));
        hash.update(`${name}\0${bytes.length}\0`);
        hash.update(bytes);
      } else throw new Error(`Unexpected linked or special package file: ${name}`);
    }
  }
  await visit();
  return hash.digest("hex");
}
