// Lazy-require LiveKit SDKs (peer dependencies) for the Realtime and Live voice eval runners.

let lkLoggerInitialized = false

/**
 * Loads the LiveKit server SDK, agents framework and RTC bindings that voice evals need.
 *
 * @throws When a package is missing, with the install command in the message.
 */
export function requireLiveKit() {
  let serverSdk: any
  let lk: any
  let rtc: any
  try {
    serverSdk = require('livekit-server-sdk')
  } catch {
    throw new Error(
      '[adk/voice-eval] livekit-server-sdk is required. Install with: npm install livekit-server-sdk',
    )
  }
  try {
    lk = require('@livekit/agents')
  } catch {
    throw new Error(
      '[adk/voice-eval] @livekit/agents is required. Install with: npm install @livekit/agents',
    )
  }
  try {
    rtc = require('@livekit/rtc-node')
  } catch {
    throw new Error(
      '[adk/voice-eval] @livekit/rtc-node is required. Install with: npm install @livekit/rtc-node',
    )
  }
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
