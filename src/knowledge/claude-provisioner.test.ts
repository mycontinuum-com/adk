/** Claude Protocol Provisioner Tests */

import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import type { ProvisioningItem } from './types'

import {
  provisionClaudeProtocol,
  cleanupProvisionedFiles,
  renderClaudeMd,
  renderRule,
  renderSettings,
} from './claude-provisioner'

describe('Claude Protocol Provisioner', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'provisioner-test-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  describe('provisionClaudeProtocol', () => {
    it('should create .claude/ and .artifacts/ directories', async () => {
      await provisionClaudeProtocol({
        workspace,
        context: [],
      })

      // Check directories exist (access resolves without throwing if file exists)
      await access(join(workspace, '.claude'))
      await access(join(workspace, '.artifacts'))
      await access(join(workspace, '.claude', 'rules'))
      await access(join(workspace, '.claude', 'skills'))
      // If we get here without throwing, the directories exist
      expect(true).toBe(true)
    })

    it('should create CLAUDE.md from instructions', async () => {
      const context: ProvisioningItem[] = [
        {
          name: 'conventions',
          content: '# Coding Conventions\n\nUse TypeScript.',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'system',
          sourceType: 'git',
        },
        {
          name: 'flow-instructions',
          content: '# Bug Fix\n\nFollow the debugging process.',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'flow',
          sourceType: 'git',
        },
      ]

      await provisionClaudeProtocol({ workspace, context })

      const content = await readFile(join(workspace, '.claude', 'CLAUDE.md'), 'utf8')

      expect(content).toContain('# System Instructions')
      expect(content).toContain('Use TypeScript')
      expect(content).toContain('# Flow Instructions')
      expect(content).toContain('Follow the debugging process')
    })

    it('should create rules with path scope', async () => {
      const context: ProvisioningItem[] = [
        {
          name: 'api-safety',
          content: 'Never expose internal errors.',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'flow',
          sourceType: 'git',
          pathScope: 'src/api/**/*.ts',
          type: 'rule',
        },
      ]

      await provisionClaudeProtocol({ workspace, context })

      const content = await readFile(join(workspace, '.claude', 'rules', 'api-safety.md'), 'utf8')

      expect(content).toContain('---')
      expect(content).toContain('paths: src/api/**/*.ts')
      expect(content).toContain('Never expose internal errors')
    })

    it('should create skills in their own directories', async () => {
      const context: ProvisioningItem[] = [
        {
          name: 'debugging-skill',
          content: '# Debugging Skill\n\nUse console.log strategically.',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'flow',
          sourceType: 'git',
          type: 'skill',
        },
      ]

      await provisionClaudeProtocol({ workspace, context })

      const content = await readFile(
        join(workspace, '.claude', 'skills', 'debugging-skill', 'SKILL.md'),
        'utf8',
      )

      expect(content).toContain('Debugging Skill')
    })

    it('should create settings.json with permissions', async () => {
      await provisionClaudeProtocol({
        workspace,
        context: [],
        flow: {
          allowedTools: ['Edit', 'Write', 'Bash(**)'],
          disallowedTools: ['WebFetch'],
        },
      })

      const content = await readFile(join(workspace, '.claude', 'settings.json'), 'utf8')
      const settings = JSON.parse(content)

      expect(settings.permissions.allow).toEqual(['Edit', 'Write', 'Bash(**)'])
      expect(settings.permissions.deny).toEqual(['WebFetch'])
    })

    it('should write artifacts to .artifacts/', async () => {
      const context: ProvisioningItem[] = [
        {
          name: 'plan',
          content: '# Implementation Plan\n\nStep 1: Do the thing',
          mimeType: 'text/markdown',
          authority: 'decision',
          scope: 'process',
          sourceType: 'agent',
        },
        {
          name: 'config',
          content: '{"key": "value"}',
          mimeType: 'application/json',
          authority: 'reference',
          scope: 'flow',
          sourceType: 'git',
        },
      ]

      await provisionClaudeProtocol({ workspace, context })

      const planContent = await readFile(join(workspace, '.artifacts', 'plan.md'), 'utf8')
      expect(planContent).toContain('Implementation Plan')

      const configContent = await readFile(join(workspace, '.artifacts', 'config.json'), 'utf8')
      expect(JSON.parse(configContent)).toEqual({ key: 'value' })
    })

    it('should add working documents reference to CLAUDE.md', async () => {
      const context: ProvisioningItem[] = [
        {
          name: 'conventions',
          content: '# Conventions\n\nBe consistent.',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'system',
          sourceType: 'git',
        },
        {
          name: 'notes',
          content: 'Some notes here.',
          mimeType: 'text/markdown',
          authority: 'reference',
          scope: 'process',
          sourceType: 'agent',
        },
      ]

      await provisionClaudeProtocol({ workspace, context })

      const content = await readFile(join(workspace, '.claude', 'CLAUDE.md'), 'utf8')

      expect(content).toContain('# Working Documents')
      expect(content).toContain('.artifacts/')
    })

    it('should return manifest with file hashes', async () => {
      const context: ProvisioningItem[] = [
        {
          name: 'test',
          content: 'test content',
          mimeType: 'text/plain',
          authority: 'instruction',
          scope: 'system',
          sourceType: 'git',
        },
      ]

      const manifest = await provisionClaudeProtocol({ workspace, context })

      expect(manifest.files.size).toBeGreaterThan(0)
      expect(manifest.files.has('.claude/CLAUDE.md')).toBe(true)
      expect(manifest.files.has('.claude/settings.json')).toBe(true)

      const claudeFile = manifest.files.get('.claude/CLAUDE.md')
      expect(claudeFile?.hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('should seed declared artifacts', async () => {
      await provisionClaudeProtocol({
        workspace,
        context: [],
        declaredArtifacts: {
          'implementation-plan': {
            mimeType: 'text/markdown',
            label: 'Implementation Plan',
          },
          'test-results': {
            mimeType: 'application/json',
          },
        },
      })

      const planContent = await readFile(
        join(workspace, '.artifacts', 'implementation-plan.md'),
        'utf8',
      )
      expect(planContent).toContain('# Implementation Plan')

      const resultsContent = await readFile(
        join(workspace, '.artifacts', 'test-results.json'),
        'utf8',
      )
      expect(resultsContent).toBe('{}')
    })

    it('should seed binary artifact placeholder as empty', async () => {
      await provisionClaudeProtocol({
        workspace,
        context: [],
        declaredArtifacts: {
          diagram: {
            mimeType: 'image/png',
          },
        },
      })

      const content = await readFile(join(workspace, '.artifacts', 'diagram.png'), 'utf8')
      expect(content).toBe('')
    })

    it('should mark inherited artifacts', async () => {
      const context: ProvisioningItem[] = [
        {
          name: 'inherited-decision',
          content: 'Parent decision',
          mimeType: 'text/markdown',
          authority: 'decision',
          scope: 'flow', // Not process = inherited
          sourceType: 'git',
        },
      ]

      const manifest = await provisionClaudeProtocol({ workspace, context })

      const artifactFile = manifest.files.get('.artifacts/inherited-decision.md')
      expect(artifactFile?.inherited).toBe(true)
    })
  })

  describe('cleanupProvisionedFiles', () => {
    it('should remove all provisioned files', async () => {
      const context: ProvisioningItem[] = [
        {
          name: 'test',
          content: 'test',
          mimeType: 'text/plain',
          authority: 'instruction',
          scope: 'system',
          sourceType: 'git',
        },
      ]

      const manifest = await provisionClaudeProtocol({ workspace, context })

      // Verify files exist
      await access(join(workspace, '.claude', 'CLAUDE.md'))

      // Clean up
      await cleanupProvisionedFiles(workspace, manifest)

      // Verify files are gone
      let fileExists = true
      try {
        await access(join(workspace, '.claude', 'CLAUDE.md'))
      } catch {
        fileExists = false
      }
      expect(fileExists).toBe(false)
    })
  })

  describe('renderClaudeMd', () => {
    it('should organize instructions by scope', () => {
      const instructions: ProvisioningItem[] = [
        {
          name: 'system-inst',
          content: 'System instruction content',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'system',
          sourceType: 'git',
        },
        {
          name: 'flow-inst',
          content: 'Flow instruction content',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'flow',
          sourceType: 'git',
        },
      ]

      const result = renderClaudeMd(instructions)

      expect(result).toContain('# System Instructions')
      expect(result).toContain('# Flow Instructions')
      expect(result.indexOf('System Instructions')).toBeLessThan(
        result.indexOf('Flow Instructions'),
      )
    })

    it('should render area and process instructions', () => {
      const instructions: ProvisioningItem[] = [
        {
          name: 'area-inst',
          content: 'Area instruction content',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'area',
          sourceType: 'git',
        },
        {
          name: 'process-inst',
          content: 'Process instruction content',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'process',
          sourceType: 'agent',
        },
      ]

      const result = renderClaudeMd(instructions)

      expect(result).toContain('# Area Instructions')
      expect(result).toContain('Area instruction content')
      expect(result).toContain('# Process Instructions')
      expect(result).toContain('Process instruction content')
    })

    it('should strip existing top-level headings', () => {
      const instructions: ProvisioningItem[] = [
        {
          name: 'test',
          content: '# My Heading\n\nActual content here.',
          mimeType: 'text/markdown',
          authority: 'instruction',
          scope: 'system',
          sourceType: 'git',
        },
      ]

      const result = renderClaudeMd(instructions)

      // Should not have duplicate "My Heading"
      const matches = result.match(/My Heading/g)
      expect(matches).toBeNull()
      expect(result).toContain('Actual content here')
    })
  })

  describe('renderRule', () => {
    it('should add paths frontmatter', () => {
      const rule: ProvisioningItem = {
        name: 'api-rule',
        content: 'Rule content here',
        mimeType: 'text/markdown',
        authority: 'instruction',
        scope: 'flow',
        sourceType: 'git',
        pathScope: 'src/api/**/*.ts',
      }

      const result = renderRule(rule)

      expect(result).toContain('---')
      expect(result).toContain('paths: src/api/**/*.ts')
      expect(result).toContain('Rule content here')
    })

    it('should preserve existing frontmatter', () => {
      const rule: ProvisioningItem = {
        name: 'api-rule',
        content: '---\npaths: existing/path\nother: value\n---\n\nContent',
        mimeType: 'text/markdown',
        authority: 'instruction',
        scope: 'flow',
        sourceType: 'git',
        pathScope: 'src/api/**/*.ts', // Different from existing
      }

      const result = renderRule(rule)

      // Should keep existing frontmatter
      expect(result).toContain('paths: existing/path')
      expect(result).toContain('other: value')
    })

    it('should insert paths into existing frontmatter without paths', () => {
      const rule: ProvisioningItem = {
        name: 'api-rule',
        content: '---\nauthor: test\n---\n\nContent without paths',
        mimeType: 'text/markdown',
        authority: 'instruction',
        scope: 'flow',
        sourceType: 'git',
        pathScope: 'src/api/**/*.ts',
      }

      const result = renderRule(rule)

      // Should insert paths: into existing frontmatter
      expect(result).toContain('paths: src/api/**/*.ts')
      expect(result).toContain('author: test')
      expect(result).toContain('Content without paths')
    })

    it('should return content as-is when no pathScope and no frontmatter', () => {
      const rule: ProvisioningItem = {
        name: 'simple-rule',
        content: 'Simple rule content',
        mimeType: 'text/markdown',
        authority: 'instruction',
        scope: 'flow',
        sourceType: 'git',
        // No pathScope
      }

      const result = renderRule(rule)

      expect(result).toBe('Simple rule content')
    })
  })

  describe('renderSettings', () => {
    it('should render empty settings when no flow config', () => {
      const result = renderSettings()
      expect(JSON.parse(result)).toEqual({})
    })

    it('should render permissions', () => {
      const result = renderSettings({
        allowedTools: ['Edit'],
        disallowedTools: ['Bash'],
      })

      const settings = JSON.parse(result)
      expect(settings.permissions.allow).toEqual(['Edit'])
      expect(settings.permissions.deny).toEqual(['Bash'])
    })
  })
})
