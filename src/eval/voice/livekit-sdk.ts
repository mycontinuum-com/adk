// Lazy-require LiveKit SDKs (peer dependencies) for the Realtime and Live voice eval runners.

let lkLoggerInitialized = false

function load(name: string): any {
  try {
    return require(name)
  } catch {
    throw new Error(`[adk/voice-eval] ${name} is required. Install with: npm install ${name}`)
  }
}

/**
 * Loads the LiveKit server SDK, agents framework and RTC bindings that voice evals need.
 *
 * @throws When a package is missing, with the install command in the message.
 */
export function requireLiveKit() {
  const serverSdk = load('livekit-server-sdk')
  const lk = load('@livekit/agents')
  const rtc = load('@livekit/rtc-node')
  if (!lkLoggerInitialized) {
    try {
      lk.initializeLogger({ pretty: false, level: 'error' })
    } catch {
      /* non-fatal */
    }
    try {
      const rtcEntry = require.resolve('@livekit/rtc-node')
      require(require('path').join(require('path').dirname(rtcEntry), 'log.cjs')).log.level =
        'silent'
    } catch {
      /* non-fatal — internal path may change across versions */
    }
    lkLoggerInitialized = true
  }
  return { serverSdk, lk, rtc }
}
