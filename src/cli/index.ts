import type { Runnable } from '../types/runnables'
import type { RunResult, Runner } from '../types/runtime'
import type { Session } from '../types/session'
import type { CLIOptions, CLIConfig, CLIHandle } from './types'

import { BaseRunner } from '../core'
import { BaseSession } from '../session'
import { initLogCapture, repatchConsole } from './logCapture'

export type { CLIOptions, CLIConfig, CLIHandle, DisplayMode } from './types'

// CLI utilities (moved here from main index to avoid leaking react/ink into the main CJS bundle)
export { extractCurrentThoughtBlock } from './event-display'
export { buildInvocationBlocks } from './blocks'
export type { InvocationBlock } from './blocks'

const ENTER_ALT_SCREEN = '\x1b[?1049h'
const EXIT_ALT_SCREEN = '\x1b[?1049l'
const CLEAR_SCREEN = '\x1b[2J\x1b[H'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

/** Everything the rendered CLI needs from the optional `ink`/`react` peers. */
interface InkRuntime {
  render: typeof import('ink').render
  React: typeof import('react')
  App: typeof import('./App').App
  SpinnerProvider: typeof import('./components/SpinnerContext').SpinnerProvider
  TerminalProvider: typeof import('./components/TerminalContext').TerminalProvider
}

/**
 * A raw `Cannot find package 'ink'` is the first thing a reader of the README hits when they try
 * `/cli` without the optional UI peers, so the message names what to install instead. Only a
 * resolution failure is substituted; anything else the modules throw on load is rethrown
 * untouched.
 */
function isModuleNotFoundError(error: unknown, depth = 3): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true
  const message = error instanceof Error ? error.message : String(error)
  if (/Cannot find (?:package|module)|Failed to (?:resolve|load)/.test(message)) return true
  // Loaders wrap the resolution failure in an error of their own, so the diagnosis lives one or
  // more links down the cause chain rather than on the error that surfaced.
  const cause = (error as { cause?: unknown } | null | undefined)?.cause
  return depth > 0 && cause !== undefined && isModuleNotFoundError(cause, depth - 1)
}

async function loadInkRuntime(): Promise<InkRuntime> {
  try {
    const [ink, react, appModule, spinner, terminal] = await Promise.all([
      import('ink'),
      import('react'),
      import('./App.js'),
      import('./components/SpinnerContext.js'),
      import('./components/TerminalContext.js'),
    ])
    return {
      render: ink.render,
      React: react.default ?? react,
      App: appModule.App,
      SpinnerProvider: spinner.SpinnerProvider,
      TerminalProvider: terminal.TerminalProvider,
    }
  } catch (error) {
    if (!isModuleNotFoundError(error)) throw error
    throw new Error(
      'CLI dependencies not found. Install them with: npm install ink ink-text-input react',
      { cause: error },
    )
  }
}

function createCLIHandle(
  runnable: Runnable<any>,
  runner: Runner,
  session: Session,
  resultPromise: Promise<RunResult>,
): CLIHandle {
  return {
    runner,
    session,
    runnable,
    // oxlint-disable-next-line eslint-plugin-unicorn(no-thenable)
    then<TResult1 = RunResult, TResult2 = never>(
      onfulfilled?: ((value: RunResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return resultPromise.then(onfulfilled, onrejected)
    },
  }
}

export function cli(runnable: Runnable<any>): CLIHandle
export function cli(runnable: Runnable<any>, input: string): CLIHandle
export function cli(runnable: Runnable<any>, config: CLIConfig): CLIHandle
export function cli(runnable: Runnable<any>, inputOrConfig?: string | CLIConfig): CLIHandle {
  initLogCapture()

  let input: string | undefined
  let config: CLIConfig = {}

  if (typeof inputOrConfig === 'string') {
    input = inputOrConfig
  } else if (inputOrConfig !== undefined) {
    config = inputOrConfig
    input = config.input
  }

  const options = config.options ?? {}
  const resolvedOptions: CLIOptions = {
    showDurations: options.showDurations ?? true,
    showIds: options.showIds ?? false,
    exitOnComplete: options.exitOnComplete ?? false,
    hooks: options.hooks,
    logBufferSize: options.logBufferSize ?? 1000,
    defaultMode: options.defaultMode ?? 'debug',
  }

  const runner =
    config.runner ??
    new BaseRunner({
      sessionService: config.sessionService,
      hooks: resolvedOptions.hooks,
    })
  const session = config.session ?? new BaseSession(runnable.name)

  let resolveResult!: (result: RunResult) => void
  let rejectResult!: (error: unknown) => void
  const resultPromise = new Promise<RunResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  // The peers load before the alt screen is entered, so a missing-dependency error is printed onto
  // the user's real terminal rather than into a screen buffer that is torn down with it.
  renderCLI({
    runnable,
    runner: runner as BaseRunner,
    session: session as BaseSession,
    input,
    options: resolvedOptions,
    onResult: (result: RunResult) => resolveResult(result),
  }).catch(rejectResult)

  return createCLIHandle(runnable, runner, session, resultPromise)
}

interface RenderCLIParams {
  runnable: Runnable<any>
  runner: BaseRunner
  session: BaseSession
  input: string | undefined
  options: CLIOptions
  onResult: (result: RunResult) => void
}

async function renderCLI(params: RenderCLIParams): Promise<void> {
  const { render, React, App, SpinnerProvider, TerminalProvider } = await loadInkRuntime()

  process.stdout.write(ENTER_ALT_SCREEN)
  process.stdout.write(HIDE_CURSOR)
  process.stdout.write(CLEAR_SCREEN)

  const cleanup = () => {
    process.stdout.write(SHOW_CURSOR)
    process.stdout.write(EXIT_ALT_SCREEN)
  }

  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })

  const { waitUntilExit } = render(
    React.createElement(
      TerminalProvider,
      null,
      React.createElement(
        SpinnerProvider,
        null,
        React.createElement(App, {
          runnable: params.runnable,
          runner: params.runner,
          session: params.session,
          initialInput: params.input,
          options: params.options,
          onResult: params.onResult,
        }),
      ),
    ),
  )

  repatchConsole()

  await waitUntilExit()
  cleanup()
  process.removeListener('exit', cleanup)
}
