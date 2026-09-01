import type { StateSchema, TypedState } from '../types/schema'
import type { VoiceHook } from './types'

export interface VoiceLoggingOptions<S extends StateSchema = StateSchema> {
  context?: (state: TypedState<S>) => Record<string, unknown>
  onLog?: (entry: Record<string, unknown>) => void
  level?: 'info' | 'debug'
}

export function voiceLoggingHook<S extends StateSchema = StateSchema>(
  options?: VoiceLoggingOptions<S>,
): VoiceHook<S> {
  const isDebug = (options?.level ?? 'info') === 'debug'
  let context: Record<string, unknown> = {}

  function emit(
    level: 'info' | 'debug',
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    if (level === 'debug' && !isDebug) return
    const entry: Record<string, unknown> = {
      level: level.toUpperCase(),
      type,
      message,
      timestamp: new Date().toISOString(),
      ...context,
      ...data,
    }
    if (options?.onLog) {
      options.onLog(entry)
    } else {
      console.log(JSON.stringify(entry))
    }
  }

  return {
    name: 'voice-logging',

    onEvent(event) {
      switch (event.type) {
        case 'user':
          emit('info', 'user', `User: ${event.text}`, { source: event.source })
          break
        case 'assistant':
          emit('info', 'assistant', `Assistant: ${event.text}`, {
            agentName: event.agentName,
            source: event.source,
          })
          break
        case 'tool_call':
          emit('debug', 'tool_call', `Tool call: ${event.name}`, {
            callId: event.callId,
            args: event.args,
          })
          break
        case 'tool_result':
          emit('debug', 'tool_result', `Tool result: ${event.name}`, {
            callId: event.callId,
            durationMs: event.durationMs,
            error: event.error,
          })
          break
        case 'invocation_start':
          emit('info', 'invocation_start', `Agent started: ${event.agentName}`, {
            invocationId: event.invocationId,
          })
          break
        case 'invocation_end':
          emit('info', 'invocation_end', `Agent ended: ${event.agentName}`, {
            invocationId: event.invocationId,
            reason: event.reason,
          })
          break
        case 'model_start':
          emit('debug', 'model_start', 'Model generation started', {
            agentName: event.agentName,
            stepIndex: event.stepIndex,
          })
          break
        case 'model_end':
          emit('debug', 'model_end', 'Model generation ended', {
            agentName: event.agentName,
            stepIndex: event.stepIndex,
            durationMs: event.durationMs,
          })
          break
      }
    },

    onVoiceEvent(event) {
      switch (event.type) {
        case 'agent_state':
          emit('debug', 'agent_state', `Agent: ${event.oldState} → ${event.newState}`, {
            oldState: event.oldState,
            newState: event.newState,
          })
          break
        case 'user_state':
          emit('debug', 'user_state', `User: ${event.oldState} → ${event.newState}`, {
            oldState: event.oldState,
            newState: event.newState,
          })
          break
        case 'speech_created':
          emit('debug', 'speech_created', `Speech created: ${event.source}`, {
            source: event.source,
          })
          break
        case 'voice_activity':
          emit('debug', 'voice_activity', `Voice activity: ${event.activity}`, {
            activity: event.activity,
            inactivityCount: event.inactivityCount,
            timeoutMs: event.timeoutMs,
            reason: event.reason,
          })
          break
        case 'lifecycle_hook_started':
          emit('debug', 'lifecycle_hook_started', `Lifecycle hook started: ${event.hookName}`, {
            hookName: event.hookName,
            reason: event.reason,
            inactivityCount: event.inactivityCount,
            hookCount: event.hookCount,
          })
          break
        case 'lifecycle_hook_completed':
          emit('debug', 'lifecycle_hook_completed', `Lifecycle hook completed: ${event.hookName}`, {
            hookName: event.hookName,
            reason: event.reason,
            inactivityCount: event.inactivityCount,
            result: event.result,
          })
          break
        case 'lifecycle_hook_failed':
          emit('info', 'lifecycle_hook_failed', `Lifecycle hook failed: ${event.hookName}`, {
            hookName: event.hookName,
            reason: event.reason,
            inactivityCount: event.inactivityCount,
            errorName: event.errorName,
            errorMessage: event.errorMessage,
          })
          break
        case 'lifecycle_before_end_started':
          emit(
            'debug',
            'lifecycle_before_end_started',
            `Lifecycle before-end started: ${event.hookName}`,
            {
              hookName: event.hookName,
              reason: event.reason,
              inactivityCount: event.inactivityCount,
            },
          )
          break
        case 'lifecycle_before_end_completed':
          emit(
            'debug',
            'lifecycle_before_end_completed',
            `Lifecycle before-end completed: ${event.hookName}`,
            {
              hookName: event.hookName,
              reason: event.reason,
              inactivityCount: event.inactivityCount,
            },
          )
          break
        case 'lifecycle_before_end_failed':
          emit(
            'info',
            'lifecycle_before_end_failed',
            `Lifecycle before-end failed: ${event.hookName}`,
            {
              hookName: event.hookName,
              reason: event.reason,
              inactivityCount: event.inactivityCount,
              errorName: event.errorName,
              errorMessage: event.errorMessage,
            },
          )
          break
        case 'output_tool_completion_started':
          emit(
            'debug',
            'output_tool_completion_started',
            `Output tool completion started: ${event.intendedToolName}`,
            {
              intendedToolName: event.intendedToolName,
              source: event.source,
              elapsedMs: event.elapsedMs,
              attempts: event.attempts,
            },
          )
          break
        case 'output_tool_completion_succeeded':
          emit(
            'debug',
            'output_tool_completion_succeeded',
            `Output tool completion succeeded: ${event.intendedToolName}`,
            {
              intendedToolName: event.intendedToolName,
              source: event.source,
              elapsedMs: event.elapsedMs,
              attempts: event.attempts,
            },
          )
          break
        case 'output_tool_completion_failed':
          emit(
            'info',
            'output_tool_completion_failed',
            `Output tool completion failed: ${event.intendedToolName}`,
            {
              intendedToolName: event.intendedToolName,
              source: event.source,
              phase: event.phase,
              elapsedMs: event.elapsedMs,
              attempts: event.attempts,
              maxAttempts: event.maxAttempts,
              incorrectToolName: event.incorrectToolName,
              forcedToolReason: event.forcedToolReason,
              errorName: event.errorName,
              errorMessage: event.errorMessage,
            },
          )
          break
        case 'forced_tool_correction':
          emit(
            'info',
            'forced_tool_correction',
            `Forced tool correction: ${event.incorrectToolName ?? 'none'} -> ${event.intendedToolName}`,
            {
              intendedToolName: event.intendedToolName,
              incorrectToolName: event.incorrectToolName,
              attempts: event.attempts,
              maxAttempts: event.maxAttempts,
              source: event.source,
            },
          )
          break
        case 'forced_tool_failure':
          emit('info', 'forced_tool_failure', `Forced tool failure: ${event.intendedToolName}`, {
            intendedToolName: event.intendedToolName,
            incorrectToolName: event.incorrectToolName,
            attempts: event.attempts,
            maxAttempts: event.maxAttempts,
            source: event.source,
            error: String(event.error),
          })
          break
        case 'voice_error':
          emit('info', 'voice_error', `Voice error: ${event.error}`, {
            error: String(event.error),
          })
          break
      }
    },

    afterTurn({ result }) {
      const data: Record<string, unknown> = { status: result.status }
      if (result.usage) {
        data.usage = {
          totalInputTokens: result.usage.totalInputTokens,
          totalOutputTokens: result.usage.totalOutputTokens,
          totalAudioInputTokens: result.usage.totalAudioInputTokens,
          totalAudioOutputTokens: result.usage.totalAudioOutputTokens,
          modelCalls: result.usage.modelCalls,
        }
        if (result.usage.cost) {
          data.cost = result.usage.cost
        }
      }
      emit('info', 'session_end', `Session ended: ${result.status}`, data)
    },

    onEnter(ctx) {
      context = {
        sessionId: ctx.session.id,
        ...options?.context?.(ctx.state),
      }
      emit('info', 'enter', 'Agent entered session')
    },

    onInactivity(ctx) {
      emit('info', 'inactivity', `Inactivity timeout (stage ${ctx.inactivityCount})`, {
        inactivityCount: ctx.inactivityCount,
      })
    },

    onExpiry() {
      emit('info', 'expiry', 'Max duration reached')
    },

    onDisconnect() {
      emit('info', 'disconnect', 'Participant disconnected')
    },
  }
}
