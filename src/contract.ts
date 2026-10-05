/** Additive standalone CLI contract; shared language-service types remain upstream. */
import type {
  PxtkOperation as CoreOperation,
  PxtkRequest as CoreRequest,
  PxtkResult as CoreResult,
} from "@px-lsp/protocol/agentTools";
import type { DefinitionOp } from "@px-lsp/protocol/protocol";
import type { MigrationAnswers } from "@px-lsp/protocol/migration";

export type PxtkOperation =
  | CoreOperation
  | "read"
  | "new"
  | "playsets"
  | "launch"
  | "rename"
  | "edit"
  | "conflicts"
  | "import"
  | "package"
  | "migrate";
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
  sourceLanguage?: string;
  line?: number;
  column?: number;
  to?: string;
  edits?: DefinitionOp[];
  inputs?: string[];
  source?: string;
  directory?: string;
  recipe?: string;
  recipeFile?: string;
  trust?: string;
  fromBuild?: string;
  toBuild?: string;
  sourceGamePath?: string;
  targetGamePath?: string;
  answers?: MigrationAnswers;
}
export interface PxtkResult<Data = Record<string, unknown>> extends Omit<CoreResult<Data>, "operation"> {
  operation: PxtkOperation;
}
export type { PxtkSources } from "@px-lsp/protocol/agentTools";
