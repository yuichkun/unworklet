import type { Plugin } from "vite-plus";

export const title: string;
export const testPath: string;
export type TransformRecord = {
  role: string;
  runId: string;
  sourcePath: string;
  sourceHash: string;
  transformedHash: string;
};
export function instrumentWorklet(source: string, record?: boolean, runId?: string): string;
export function instrumentClient(source: string, record?: boolean, runId?: string): string;
export function instrumentTest(source: string, runId?: string): string;
export function diagnosticPlugin(
  coreRoot: string,
  record: boolean,
  runId: string,
  recordTransform: (record: TransformRecord) => void,
): Plugin;
