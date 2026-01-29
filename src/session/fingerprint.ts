import { createHash } from 'node:crypto';
import type { Runnable, Tool } from '../types';

interface FingerprintNode {
  kind: string;
  name: string;
  tools?: string[];
  children?: FingerprintNode[];
  yields?: boolean;
}

function buildFingerprintTree(runnable: Runnable): FingerprintNode {
  const base: FingerprintNode = {
    kind: runnable.kind,
    name: runnable.name,
  };

  switch (runnable.kind) {
    case 'agent':
      if (runnable.tools.length > 0) {
        base.tools = runnable.tools.map((t: Tool) => t.name).sort();
      }
      break;

    case 'sequence':
    case 'parallel':
      base.children = runnable.runnables.map(buildFingerprintTree);
      break;

    case 'loop':
      base.children = [buildFingerprintTree(runnable.runnable)];
      if (runnable.yields) {
        base.yields = true;
      }
      break;

    case 'step':
      break;
  }

  return base;
}

export function computePipelineFingerprint(runnable: Runnable): string {
  const tree = buildFingerprintTree(runnable);
  const json = JSON.stringify(tree);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}
