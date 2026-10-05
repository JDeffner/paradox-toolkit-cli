import ignore from "ignore";
import { gameMetas } from "@px-lsp/server/games/metaRegistry";

/** Host-only extraction of Toolkit packages/vscode/src/steam/pxignore.ts.
 * The ignore list is packaging policy, not game knowledge. Config names come from profiles.
 * An existing .pxignore replaces defaults; mandatory exclusions and descriptors still win.
 */
export const DEFAULT_PACKAGE_IGNORE = `
.git/
.gitignore
.gitattributes
.github/
.vscode/
.idea/
.claude/
CLAUDE.md
AGENTS.md
node_modules/
*-tiger.conf
*.psd
*.xcf
*.kra
*.blend
*.zip
*.7z
*.rar
Thumbs.db
.DS_Store
desktop.ini
`;
export function packageFilter(text: string | null) {
  const excluded = new Set([
    ".pxignore",
    ...Object.values(gameMetas).flatMap((meta) => [
      meta.configDirName,
      ...(meta.legacyConfigDirName ? [meta.legacyConfigDirName] : []),
    ]),
  ]);
  const matcher = ignore().add(text ?? DEFAULT_PACKAGE_IGNORE);
  return (relative: string, directory: boolean): string | null => {
    const top = relative.split("/")[0];
    if (excluded.has(top)) return "toolkit configuration";
    if (top === "descriptor.mod" || top === ".metadata") return null;
    return matcher.ignores(relative + (directory ? "/" : "")) ? ".pxignore policy" : null;
  };
}
