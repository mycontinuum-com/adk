import { vi } from 'vitest'

import { configureUsageLog } from '../core/usage-log'
import { configurePricing } from '../providers/pricing'
import { setupAdkMatchers } from './matchers'

setupAdkMatchers()

vi.mock('ink', () => import('./mocks/ink.js'))
vi.mock('ink-text-input', () => import('./mocks/ink-text-input.js'))

// Unit tests must not reach the live pricing registry, nor fill the output with usage lines.
configurePricing(false)
configureUsageLog(false)
