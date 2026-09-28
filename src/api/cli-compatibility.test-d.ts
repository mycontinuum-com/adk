import { expectTypeOf } from 'vitest'

import { adk, cliHook, consoleHook, type CliHookOptions, type ConsoleHookOptions } from '../index'
import {
  cli,
  terminal,
  type CLIConfig,
  type CLIHandle,
  type CLIOptions,
  type CLIStatus,
  type TerminalConfig,
  type TerminalHandle,
  type TerminalOptions,
  type TerminalStatus,
} from '../terminal'

const app = adk()
expectTypeOf(app.cli).toEqualTypeOf(app.terminal)
expectTypeOf(cli).toEqualTypeOf(terminal)
expectTypeOf(cliHook).toEqualTypeOf(consoleHook)
expectTypeOf(app.hook.cli).toEqualTypeOf(app.hook.console)
expectTypeOf<CLIConfig>().toEqualTypeOf<TerminalConfig>()
expectTypeOf<CLIHandle>().toEqualTypeOf<TerminalHandle>()
expectTypeOf<CLIOptions>().toEqualTypeOf<TerminalOptions>()
expectTypeOf<CLIStatus>().toEqualTypeOf<TerminalStatus>()
expectTypeOf<CliHookOptions>().toEqualTypeOf<ConsoleHookOptions>()
