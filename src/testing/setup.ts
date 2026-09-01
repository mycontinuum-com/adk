import { vi } from 'vitest'

import { setupAdkMatchers } from './matchers'

setupAdkMatchers()

vi.mock('ink', () => import('./mocks/ink.js'))
vi.mock('ink-text-input', () => import('./mocks/ink-text-input.js'))
