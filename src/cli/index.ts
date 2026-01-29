import { initLogCapture, repatchConsole } from './logCapture';
import React from 'react';
import { render } from 'ink';
import type { Runnable, RunResult } from '../types';
import type { CLIOptions, CLIConfig, CLIHandle } from './types';
import { BaseRunner } from '../core';
import { BaseSession } from '../session';
import { App } from './App';
import { SpinnerProvider } from './components/SpinnerContext';
import { TerminalProvider } from './components/TerminalContext';

export type { CLIOptions, CLIConfig, CLIHandle, DisplayMode } from './types';

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function createCLIHandle(
  runnable: Runnable,
  runner: BaseRunner,
  session: BaseSession,
  resultPromise: Promise<RunResult>,
): CLIHandle {
  return {
    runner,
    session,
    runnable,
    then<TResult1 = RunResult, TResult2 = never>(
      onfulfilled?:
        | ((value: RunResult) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): Promise<TResult1 | TResult2> {
      return resultPromise.then(onfulfilled, onrejected);
    },
  };
}

export function cli(
  runnable: Runnable,
  prompt?: string,
  options?: CLIOptions,
): CLIHandle;
export function cli(runnable: Runnable, config: CLIConfig): CLIHandle;
export function cli(runnable: Runnable, options?: CLIOptions): CLIHandle;
export function cli(
  runnable: Runnable,
  promptOrConfigOrOptions?: string | CLIConfig | CLIOptions,
  maybeOptions?: CLIOptions,
): CLIHandle {
  initLogCapture();

  let prompt: string | undefined;
  let config: CLIConfig = {};

  if (typeof promptOrConfigOrOptions === 'string') {
    prompt = promptOrConfigOrOptions;
    config = { options: maybeOptions };
  } else if (promptOrConfigOrOptions !== undefined) {
    if (
      'runner' in promptOrConfigOrOptions ||
      'session' in promptOrConfigOrOptions ||
      'prompt' in promptOrConfigOrOptions
    ) {
      config = promptOrConfigOrOptions as CLIConfig;
      prompt = config.prompt;
    } else {
      config = { options: promptOrConfigOrOptions as CLIOptions };
    }
  }

  const options = config.options ?? {};
  const resolvedOptions: CLIOptions = {
    showDurations: options.showDurations ?? true,
    showIds: options.showIds ?? false,
    exitOnComplete: options.exitOnComplete ?? false,
    middleware: options.middleware,
    logBufferSize: options.logBufferSize ?? 1000,
    defaultMode: options.defaultMode ?? 'debug',
  };

  const runner =
    config.runner ??
    new BaseRunner({
      sessionService: config.sessionService,
      middleware: resolvedOptions.middleware,
    });
  const session = config.session ?? new BaseSession('cli');

  process.stdout.write(ENTER_ALT_SCREEN);
  process.stdout.write(HIDE_CURSOR);
  process.stdout.write(CLEAR_SCREEN);

  const cleanup = () => {
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(EXIT_ALT_SCREEN);
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  let resolveResult: (result: RunResult) => void;
  const resultPromise = new Promise<RunResult>((resolve) => {
    resolveResult = resolve;
  });

  const { waitUntilExit } = render(
    React.createElement(
      TerminalProvider,
      null,
      React.createElement(
        SpinnerProvider,
        null,
        React.createElement(App, {
          runnable,
          runner,
          session,
          initialPrompt: prompt,
          options: resolvedOptions,
          onResult: (result: RunResult) => resolveResult(result),
        }),
      ),
    ),
  );

  repatchConsole();

  waitUntilExit().then(() => {
    cleanup();
    process.removeListener('exit', cleanup);
  });

  return createCLIHandle(runnable, runner, session, resultPromise);
}

/** @deprecated Use `cli()` instead */
export function runCLI(
  runnable: Runnable,
  prompt?: string,
  options?: CLIOptions,
): CLIHandle;
/** @deprecated Use `cli()` instead */
export function runCLI(runnable: Runnable, options?: CLIOptions): CLIHandle;
/** @deprecated Use `cli()` instead */
export function runCLI(
  runnable: Runnable,
  promptOrOptions?: string | CLIOptions,
  maybeOptions?: CLIOptions,
): CLIHandle {
  if (typeof promptOrOptions === 'string') {
    return cli(runnable, promptOrOptions, maybeOptions);
  }
  return cli(runnable, promptOrOptions);
}
