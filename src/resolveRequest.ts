import { findConfig, resolveConfig, type ResolveOptions } from "./config";
import type { PxtkRequest } from "./contract";
import { validateRequest } from "./requests";

/** Resolve new-mod destinations without requiring an existing workspace. */
export async function resolveRequest(options: ResolveOptions, request: PxtkRequest) {
  validateRequest(request);
  if (
    request.operation === "launch" ||
    request.operation === "playsets" ||
    (request.operation === "migrate" && request.action !== "preview") ||
    (request.operation === "conflicts" && request.inputs !== undefined)
  )
    return resolveConfig({ ...options, gameOnly: true });
  return resolveConfig(
    request.operation === "new"
      ? {
          ...options,
          // Reuse the selected game's configuration, while always replacing its editable root.
          config: options.config ?? (await findConfig(options.cwd ?? process.cwd())) ?? undefined,
          creatingMod: true,
          overrides: { ...options.overrides, mod: request.output },
        }
      : options
  );
}
