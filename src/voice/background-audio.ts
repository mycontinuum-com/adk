import type { LKBackgroundAudioPlayer, LKImports, LKPlayHandle } from './livekit-types'

/** Decodes a sound file once. Undefined when the file cannot be read or has no audio. */
export async function preloadAudioFrames(
  lk: Pick<LKImports, 'audioFramesFromFile'>,
  source: string,
): Promise<unknown[] | undefined> {
  try {
    const frames: unknown[] = []
    for await (const frame of lk.audioFramesFromFile(source)) {
      frames.push(frame)
    }
    return frames.length > 0 ? frames : undefined
  } catch {
    return undefined
  }
}

async function* loopFrames(frames: readonly unknown[]): AsyncGenerator<unknown> {
  while (true) {
    for (const frame of frames) {
      yield frame
    }
  }
}

export interface ThinkingSound {
  /** Starts the looping sound, unless it is already playing. */
  play(): void
  stop(): void
}

/** The thinking sound on a started player, looping its preloaded frames. */
export function createThinkingSound(
  player: Pick<LKBackgroundAudioPlayer, 'play'>,
  frames: readonly unknown[],
  volume: number,
): ThinkingSound {
  let handle: LKPlayHandle | undefined
  return {
    play() {
      if (handle && !handle.done()) return
      handle = player.play({ source: loopFrames(frames), volume }, false)
    },
    stop() {
      handle?.stop()
      handle = undefined
    },
  }
}
