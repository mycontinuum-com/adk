import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

import { wavHeader, sanitize, isAudioPub, mixAndWrite, startRecordingSession } from './recording'

const SAMPLE_RATE = 48_000
const CHANNELS = 1
const BYTES_PER_SAMPLE = 2

function tmpDir(): string {
  const dir = join(
    tmpdir(),
    `adk-recording-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

function makePcmBuffer(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * BYTES_PER_SAMPLE)
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], i * BYTES_PER_SAMPLE)
  }
  return buf
}

function readPcmSamples(buf: Buffer, offset: number, count: number): number[] {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    samples.push(buf.readInt16LE(offset + i * BYTES_PER_SAMPLE))
  }
  return samples
}

describe('Recording module', () => {
  describe('sanitize', () => {
    test('passes through alphanumeric, dot, dash, underscore', () => {
      expect(sanitize('call-123_v2.session')).toBe('call-123_v2.session')
    })

    test('replaces spaces and special characters with underscores', () => {
      expect(sanitize('my call/with:special chars!')).toBe('my_call_with_special_chars_')
    })

    test('handles empty string', () => {
      expect(sanitize('')).toBe('')
    })

    test('replaces unicode characters', () => {
      expect(sanitize('café-résumé')).toBe('caf_-r_sum_')
    })
  })

  describe('isAudioPub', () => {
    test('returns true for kind "AUDIO"', () => {
      expect(isAudioPub({ kind: 'AUDIO' })).toBe(true)
    })

    test('returns true for kind 1 (numeric)', () => {
      expect(isAudioPub({ kind: 1 })).toBe(true)
    })

    test('returns false for kind "VIDEO"', () => {
      expect(isAudioPub({ kind: 'VIDEO' })).toBe(false)
    })

    test('returns false for kind 0', () => {
      expect(isAudioPub({ kind: 0 })).toBe(false)
    })

    test('falls back to track.kind when pub.kind is undefined', () => {
      expect(isAudioPub({ track: { kind: 'AUDIO' } })).toBe(true)
      expect(isAudioPub({ track: { kind: 1 } })).toBe(true)
      expect(isAudioPub({ track: { kind: 'VIDEO' } })).toBe(false)
    })

    test('returns false when no kind available', () => {
      expect(isAudioPub({})).toBe(false)
      expect(isAudioPub({ track: {} })).toBe(false)
    })
  })

  describe('wavHeader', () => {
    test('produces a 44-byte buffer', () => {
      const header = wavHeader(0)
      expect(header.length).toBe(44)
    })

    test('starts with RIFF and contains WAVE', () => {
      const header = wavHeader(1000)
      expect(header.toString('ascii', 0, 4)).toBe('RIFF')
      expect(header.toString('ascii', 8, 12)).toBe('WAVE')
      expect(header.toString('ascii', 12, 16)).toBe('fmt ')
      expect(header.toString('ascii', 36, 40)).toBe('data')
    })

    test('encodes correct file size (36 + data size)', () => {
      const dataSize = 96000
      const header = wavHeader(dataSize)
      expect(header.readUInt32LE(4)).toBe(36 + dataSize)
    })

    test('encodes PCM format (1)', () => {
      const header = wavHeader(0)
      expect(header.readUInt16LE(20)).toBe(1)
    })

    test('encodes correct channel count', () => {
      const header = wavHeader(0)
      expect(header.readUInt16LE(22)).toBe(CHANNELS)
    })

    test('encodes correct sample rate', () => {
      const header = wavHeader(0)
      expect(header.readUInt32LE(24)).toBe(SAMPLE_RATE)
    })

    test('encodes correct byte rate (sampleRate * channels * bytesPerSample)', () => {
      const header = wavHeader(0)
      const expectedByteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE
      expect(header.readUInt32LE(28)).toBe(expectedByteRate)
    })

    test('encodes correct block align', () => {
      const header = wavHeader(0)
      expect(header.readUInt16LE(32)).toBe(CHANNELS * BYTES_PER_SAMPLE)
    })

    test('encodes correct bits per sample', () => {
      const header = wavHeader(0)
      expect(header.readUInt16LE(34)).toBe(BYTES_PER_SAMPLE * 8)
    })

    test('encodes data size in data chunk header', () => {
      const dataSize = 48000
      const header = wavHeader(dataSize)
      expect(header.readUInt32LE(40)).toBe(dataSize)
    })
  })

  describe('mixAndWrite', () => {
    let dir: string

    beforeEach(() => {
      dir = tmpDir()
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    test('single track — copies PCM data with WAV header', async () => {
      const samples = [100, -200, 300, -400, 500]
      const pcm = makePcmBuffer(samples)
      const trackPath = join(dir, 'track0.raw')
      writeFileSync(trackPath, pcm)

      const outputPath = join(dir, 'output.wav')
      await mixAndWrite([trackPath], outputPath)

      expect(existsSync(outputPath)).toBe(true)

      const output = readFileSync(outputPath)
      expect(output.length).toBe(44 + pcm.length)

      expect(output.toString('ascii', 0, 4)).toBe('RIFF')
      expect(output.readUInt32LE(40)).toBe(pcm.length)

      const outputSamples = readPcmSamples(output, 44, samples.length)
      expect(outputSamples).toEqual(samples)
    })

    test('two tracks — sums samples with correct values', async () => {
      const samplesA = [1000, -2000, 3000, 0, 5000]
      const samplesB = [500, 2000, -1000, 4000, -3000]
      const expected = [1500, 0, 2000, 4000, 2000]

      const pathA = join(dir, 'a.raw')
      const pathB = join(dir, 'b.raw')
      writeFileSync(pathA, makePcmBuffer(samplesA))
      writeFileSync(pathB, makePcmBuffer(samplesB))

      const outputPath = join(dir, 'mixed.wav')
      await mixAndWrite([pathA, pathB], outputPath)

      const output = readFileSync(outputPath)
      const outputSamples = readPcmSamples(output, 44, expected.length)
      expect(outputSamples).toEqual(expected)
    })

    test('mixing clamps at int16 max (32767)', async () => {
      const samplesA = [30000, 32767]
      const samplesB = [10000, 1]

      const pathA = join(dir, 'a.raw')
      const pathB = join(dir, 'b.raw')
      writeFileSync(pathA, makePcmBuffer(samplesA))
      writeFileSync(pathB, makePcmBuffer(samplesB))

      const outputPath = join(dir, 'clamped.wav')
      await mixAndWrite([pathA, pathB], outputPath)

      const output = readFileSync(outputPath)
      const outputSamples = readPcmSamples(output, 44, 2)
      expect(outputSamples[0]).toBe(32767)
      expect(outputSamples[1]).toBe(32767)
    })

    test('mixing clamps at int16 min (-32768)', async () => {
      const samplesA = [-30000, -32768]
      const samplesB = [-10000, -1]

      const pathA = join(dir, 'a.raw')
      const pathB = join(dir, 'b.raw')
      writeFileSync(pathA, makePcmBuffer(samplesA))
      writeFileSync(pathB, makePcmBuffer(samplesB))

      const outputPath = join(dir, 'clamped-min.wav')
      await mixAndWrite([pathA, pathB], outputPath)

      const output = readFileSync(outputPath)
      const outputSamples = readPcmSamples(output, 44, 2)
      expect(outputSamples[0]).toBe(-32768)
      expect(outputSamples[1]).toBe(-32768)
    })

    test('tracks of different lengths — shorter track treated as silence', async () => {
      const samplesA = [1000, 2000, 3000, 4000]
      const samplesB = [500, 600]

      const pathA = join(dir, 'long.raw')
      const pathB = join(dir, 'short.raw')
      writeFileSync(pathA, makePcmBuffer(samplesA))
      writeFileSync(pathB, makePcmBuffer(samplesB))

      const outputPath = join(dir, 'difflen.wav')
      await mixAndWrite([pathA, pathB], outputPath)

      const output = readFileSync(outputPath)
      const dataSize = samplesA.length * BYTES_PER_SAMPLE
      expect(output.readUInt32LE(40)).toBe(dataSize)

      const outputSamples = readPcmSamples(output, 44, 4)
      expect(outputSamples[0]).toBe(1500)
      expect(outputSamples[1]).toBe(2600)
      expect(outputSamples[2]).toBe(3000)
      expect(outputSamples[3]).toBe(4000)
    })

    test('three tracks mixed together', async () => {
      const a = [1000, 2000]
      const b = [3000, 4000]
      const c = [5000, 6000]

      const pa = join(dir, 'a.raw')
      const pb = join(dir, 'b.raw')
      const pc = join(dir, 'c.raw')
      writeFileSync(pa, makePcmBuffer(a))
      writeFileSync(pb, makePcmBuffer(b))
      writeFileSync(pc, makePcmBuffer(c))

      const outputPath = join(dir, 'three.wav')
      await mixAndWrite([pa, pb, pc], outputPath)

      const output = readFileSync(outputPath)
      const outputSamples = readPcmSamples(output, 44, 2)
      expect(outputSamples[0]).toBe(9000)
      expect(outputSamples[1]).toBe(12000)
    })

    test('empty tracks produce no output', async () => {
      const pathA = join(dir, 'empty.raw')
      writeFileSync(pathA, Buffer.alloc(0))

      const outputPath = join(dir, 'empty.wav')
      await mixAndWrite([pathA], outputPath)

      expect(existsSync(outputPath)).toBe(false)
    })
  })

  describe('startRecordingSession', () => {
    test('stop is idempotent', async () => {
      const room = {
        on: vi.fn<(...args: unknown[]) => unknown>(),
        off: vi.fn<(...args: unknown[]) => unknown>(),
      }

      const session = await startRecordingSession(room, {}, 'test-session')
      await session.stop()
      await session.stop()
    })

    test('no-ops when config has no dir or egress', async () => {
      const room = {
        on: vi.fn<(...args: unknown[]) => unknown>(),
        off: vi.fn<(...args: unknown[]) => unknown>(),
      }

      const session = await startRecordingSession(room, {}, 'test-session')
      await session.stop()
    })
  })
})
