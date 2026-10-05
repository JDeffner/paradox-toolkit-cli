/** Additive standalone CLI contract; shared language-service types remain upstream. */
import type {
  PxtkOperation as CoreOperation,
  PxtkRequest as CoreRequest,
  PxtkResult as CoreResult,
} from "@px-lsp/protocol/agentTools";

export type PxtkOperation = CoreOperation | "read" | "new" | "playsets" | "launch";
export interface PxtkRequest extends Omit<CoreRequest, "operation"> {
  operation: PxtkOperation;
  writeBaseline?: string;
  startLine?: number;
  startColumn?: number;
  lineCount?: number;
  maxChars?: number;
  sourceHash?: string;
  supportedVersion?: string;
  playset?: string;
  args?: string[];
  preset?: string;
  start?: boolean;
}
export interface PxtkResult<Data = Record<string, unknown>> extends Omit<CoreResult<Data>, "operation"> {
  operation: PxtkOperation;
}
export type { PxtkSources } from "@px-lsp/protocol/agentTools";
