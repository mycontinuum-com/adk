import type { Runnable, Event } from '../../types';
import type { ResumeContext } from '../../core';
import type { SequenceResumeContext } from '../../agents/sequential';
import type { ParallelResumeContext } from '../../agents/parallel';
import type { LoopResumeContext } from '../../agents/loop';
import {
  buildInvocationTree,
  getNodePath,
  findYieldedNodes,
  getUnresolvedYields,
  hasUnresolvedYields,
  type InvocationNode,
  type InvocationState,
  type UnresolvedYield,
} from './tree';

export type RunnableResumeContext =
  | ResumeContext
  | SequenceResumeContext
  | ParallelResumeContext
  | LoopResumeContext;

const TERMINAL_STATES: ReadonlySet<InvocationState> = new Set([
  'completed',
  'error',
  'aborted',
]);

export function validateResumeState(
  events: readonly Event[],
): UnresolvedYield[] {
  const tree = buildInvocationTree(events);
  if (tree.length === 0) return [];

  return tree.flatMap(getUnresolvedYields);
}

export function assertReadyToResume(events: readonly Event[]): void {
  const unresolvedYields = validateResumeState(events);
  if (unresolvedYields.length > 0) {
    const details = unresolvedYields
      .map((u) => `callId '${u.callId}' in runnable '${u.agentName}'`)
      .join(', ');
    throw new Error(
      `Cannot resume: missing tool results for pending yields: ${details}`,
    );
  }
}

export function computeResumeContext(
  events: readonly Event[],
  runnable: Runnable,
): RunnableResumeContext | undefined {
  const tree = buildInvocationTree(events);
  if (tree.length === 0) return undefined;

  const rootNode = tree[0];
  if (TERMINAL_STATES.has(rootNode.state)) return undefined;

  const yieldedNodes = findYieldedNodes(tree);
  if (yieldedNodes.length === 0) return undefined;

  if (yieldedNodes.some(hasUnresolvedYields)) return undefined;

  const deepestYielded = yieldedNodes[yieldedNodes.length - 1];
  const path = getNodePath(tree, deepestYielded.invocationId);
  if (path.length === 0) return undefined;

  return buildContextForPath(path, runnable);
}

function buildContextForPath(
  path: InvocationNode[],
  runnable: Runnable,
): RunnableResumeContext | undefined {
  if (path.length === 0) return undefined;

  const root = path[0];
  const baseContext: ResumeContext = {
    invocationId: root.invocationId,
    yieldIndex: root.yieldIndex ?? 0,
  };

  switch (runnable.kind) {
    case 'agent':
      return baseContext;
    case 'sequence':
      return path.length === 1
        ? baseContext
        : buildSequenceContext(path, runnable);
    case 'parallel':
      return path.length === 1
        ? baseContext
        : buildParallelContext(path, runnable);
    case 'loop':
      return buildLoopContext(path, runnable);
    default:
      return baseContext;
  }
}

function buildSequenceContext(
  path: InvocationNode[],
  runnable: Runnable & { kind: 'sequence' },
): SequenceResumeContext {
  const root = path[0];
  const childInPath = path[1];

  if (!childInPath) {
    return {
      invocationId: root.invocationId,
      yieldIndex: root.yieldIndex ?? 0,
      stepIndex: 0,
    };
  }

  let stepIndex = runnable.runnables.findIndex(
    (step) => step.name === childInPath.agentName,
  );
  if (stepIndex === -1) {
    stepIndex = root.children.findIndex(
      (c) => c.invocationId === childInPath.invocationId,
    );
    if (stepIndex < 0 || stepIndex >= runnable.runnables.length) stepIndex = 0;
  }

  const childStep = runnable.runnables[stepIndex];
  let stepResumeContext: ResumeContext | undefined;

  if (path.length > 2 && childStep) {
    stepResumeContext = buildContextForPath(path.slice(1), childStep);
  } else if (path.length === 2) {
    stepResumeContext = {
      invocationId: childInPath.invocationId,
      yieldIndex: childInPath.yieldIndex ?? 0,
    };
  }

  return {
    invocationId: root.invocationId,
    yieldIndex: root.yieldIndex ?? 0,
    stepIndex,
    stepResumeContext,
  };
}

function buildParallelContext(
  path: InvocationNode[],
  runnable: Runnable & { kind: 'parallel' },
): ParallelResumeContext {
  const root = path[0];
  const yieldedBranchIndices: number[] = [];
  const completedBranchIndices: number[] = [];
  const branchResumeContexts = new Map<number, ResumeContext>();

  const findBranchIndex = (child: InvocationNode): number => {
    const idx = runnable.runnables.findIndex((b) => b.name === child.agentName);
    if (idx >= 0) return idx;
    const childIdx = root.children.indexOf(child);
    return childIdx >= 0 && childIdx < runnable.runnables.length
      ? childIdx
      : -1;
  };

  for (const child of root.children) {
    const branchIndex = findBranchIndex(child);
    if (branchIndex < 0) continue;

    if (child.state === 'yielded') {
      yieldedBranchIndices.push(branchIndex);
      branchResumeContexts.set(branchIndex, {
        invocationId: child.invocationId,
        yieldIndex: child.yieldIndex ?? 0,
      });
    } else if (child.state === 'completed') {
      completedBranchIndices.push(branchIndex);
    }
  }

  return {
    invocationId: root.invocationId,
    yieldIndex: root.yieldIndex ?? 0,
    yieldedBranchIndices,
    completedBranchIndices,
    branchResumeContexts,
  };
}

function buildLoopContext(
  path: InvocationNode[],
  runnable: Runnable & { kind: 'loop' },
): LoopResumeContext {
  const root = path[0];
  const lastChild = root.children[root.children.length - 1];

  let iteration: number;
  let iterationResumeContext: ResumeContext | undefined;

  if (lastChild?.state === 'yielded') {
    iteration = root.children.length > 0 ? root.children.length - 1 : 0;
    iterationResumeContext =
      path.length > 2
        ? buildContextForPath(path.slice(1), runnable.runnable)
        : {
            invocationId: lastChild.invocationId,
            yieldIndex: lastChild.yieldIndex ?? 0,
          };
  } else {
    iteration = root.children.length;
    iterationResumeContext = undefined;
  }

  return {
    invocationId: root.invocationId,
    yieldIndex: root.yieldIndex ?? 0,
    iteration,
    iterationResumeContext,
  };
}
