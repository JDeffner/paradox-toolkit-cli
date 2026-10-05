import * as fs from "node:fs";
import * as path from "node:path";

const ENV_SUFFIX = {
  gamePath: "GAME_PATH",
  logsPath: "LOGS_PATH",
  tigerPath: "TIGER_PATH",
} as const;

type DevPathKey = keyof typeof ENV_SUFFIX;
const configFile = path.resolve(__dirname, "..", "dev-paths.json");

export function devPath(key: DevPathKey, gameId = "ck3"): string | null {
  const fromEnv = process.env[`PX_${gameId.toUpperCase()}_${ENV_SUFFIX[key]}`];
  if (fromEnv?.trim()) return fromEnv;
  let raw: string;
  try {
    raw = fs.readFileSync(configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const config = JSON.parse(raw) as { games?: Record<string, Partial<Record<DevPathKey, unknown>>> };
  const value = config.games?.[gameId]?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${configFile}: games.${gameId}.${key} must be a non-empty path string.`);
  }
  return path.resolve(path.dirname(configFile), value);
}

export function requireDevPath(key: DevPathKey, scriptName: string, gameId = "ck3"): string {
  const value = devPath(key, gameId);
  if (!value) {
    throw new Error(
      `${scriptName}: no ${key} configured for ${gameId}. Set PX_${gameId.toUpperCase()}_${ENV_SUFFIX[key]} ` +
        `or games.${gameId}.${key} in dev-paths.json (copy dev-paths.example.json).`
    );
  }
  return value;
}
