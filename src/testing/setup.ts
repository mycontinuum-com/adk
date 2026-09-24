import { vi } from 'vitest'

import { configurePricing } from '../providers/pricing'
import { setupAdkMatchers } from './matchers'

setupAdkMatchers()

vi.mock('ink', () => import('./mocks/ink.js'))
vi.mock('ink-text-input', () => import('./mocks/ink-text-input.js'))

// Unit tests must not reach the live pricing registry.
configurePricing(false)
