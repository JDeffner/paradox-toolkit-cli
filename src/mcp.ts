import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { definitions } from "./requests";
import type { PxtkOperation, PxtkRequest } from "./contract";
import { type ResolveOptions } from "./config";
import { resolveRequest } from "./resolveRequest";
import { responseSchema } from "./responses";
import { execute } from "./operations";
import { errorMessage, ToolError } from "./errors";
import { version } from "../package.json";

export function registerTools(server: McpServer, config: ResolveOptions, signal: AbortSignal) {
  let queue: Promise<unknown> = Promise.resolve();
  for (const definition of definitions) {
    server.registerTool(
      `pxtk_${definition.operation}`,
      {
        description: definition.description,
        inputSchema: z.strictObject(definition.schema),
        outputSchema: responseSchema(definition.operation),
        annotations: {
          readOnlyHint: !definition.writes,
          destructiveHint: !!definition.writes,
          idempotentHint: !definition.writes,
          openWorldHint: definition.openWorld ?? false,
        },
      },
      async (args: Omit<PxtkRequest, "operation">, extra: { signal: AbortSignal }) => {
        const run = async () => {
          try {
            const request: PxtkRequest = { operation: definition.operation as PxtkOperation, ...args };
            const result = await execute(await resolveRequest(config, request), request, {
              signal: AbortSignal.any([signal, extra.signal]),
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: { ...result },
              ...(result.status === "incomplete" ? { isError: true } : {}),
            };
          } catch (error) {
            const result = {
              schemaVersion: 1,
              status: "error",
              error: {
                code: error instanceof ToolError ? error.code : "operation_failed",
                message: errorMessage(error),
              },
            };
            return {
              isError: true,
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          }
        };
        const result = queue.then(run, run);
        queue = result;
        return result;
      }
    );
  }
  return () => queue;
}

export async function serveMcp(config: ResolveOptions, signal: AbortSignal): Promise<void> {
  const lifetime = new AbortController();
  const server = new McpServer({ name: "pxtk", version });
  const drain = registerTools(server, config, AbortSignal.any([signal, lifetime.signal]));
  const transport = new StdioServerTransport();
  const stopped = new Promise<void>((resolve) => {
    server.server.onclose = () => {
      lifetime.abort();
      resolve();
    };
  });
  const abort = () => {
    lifetime.abort();
    void server.close().then(
      () => {},
      (error: unknown) => {
        process.stderr.write(errorMessage(error) + "\n");
      }
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  process.stdin.once("end", abort);
  process.stdin.once("error", abort);
  await server.connect(transport);
  if (signal.aborted) abort();
  await stopped;
  await drain();
  signal.removeEventListener("abort", abort);
  process.stdin.removeListener("end", abort);
  process.stdin.removeListener("error", abort);
}
