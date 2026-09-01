/**
 * Claude Protocol Provisioner
 *
 * Provisions assembled knowledge to a workspace using Claude Code's native protocol (.claude/
 * directory structure).
 *
 * Provisioning rules: 1. Instructions (no pathScope, not skill) → .claude/CLAUDE.md 2. Path-scoped
 * rules → .claude/rules/{name}.md with paths: frontmatter 3. Skills →
 * .claude/skills/{name}/SKILL.md 4. Flow permissions → .claude/settings.json 5. Everything else →
 * .artifacts/{name}.{ext}
 *
 * @module
 * @example
 *   ;```typescript
 *   const manifest = await provisionClaudeProtocol({
 *     workspace: '/path/to/workspace',
 *     context: assembledContext,
 *     flow: {
 *       allowedTools: ['Edit', 'Write', 'Bash(**)'],
 *     },
 *   })
 *   ```
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'

import type {
  ProvisioningItem,
  ProvisionManifest,
  ProvisionedFile,
  ProvisionOptions,
  ClaudeSettings,
} from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_DIR = '.claude'
const ARTIFACTS_DIR = '.artifacts'
const CLAUDE_MD = 'CLAUDE.md'
const SETTINGS_JSON = 'settings.json'
const RULES_DIR = 'rules'
const SKILLS_DIR = 'skills'
const SKILL_FILE = 'SKILL.md'

// ─────────────────────────────────────────────────────────────────────────────
// Main Provisioner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provision assembled knowledge to a workspace.
 *
 * @param options - Provision options
 * @returns Manifest of provisioned files
 */
export async function provisionClaudeProtocol(
  options: ProvisionOptions,
): Promise<ProvisionManifest> {
  const { workspace, context, flow, declaredArtifacts } = options
  const manifest: ProvisionManifest = {
    files: new Map(),
    provisionedAt: new Date(),
  }

  // Ensure directories exist
  await mkdir(join(workspace, CLAUDE_DIR, RULES_DIR), { recursive: true })
  await mkdir(join(workspace, CLAUDE_DIR, SKILLS_DIR), { recursive: true })
  await mkdir(join(workspace, ARTIFACTS_DIR), { recursive: true })

  // Categorize context items
  const instructions: ProvisioningItem[] = []
  const rules: ProvisioningItem[] = []
  const skills: ProvisioningItem[] = []
  const artifacts: ProvisioningItem[] = []

  for (const item of context) {
    if (item.type === 'skill') {
      skills.push(item)
    } else if (item.type === 'rule' || item.pathScope) {
      rules.push(item)
    } else if (item.authority === 'instruction' && !item.pathScope) {
      instructions.push(item)
    } else {
      artifacts.push(item)
    }
  }

  // 1. Render CLAUDE.md from instructions
  const claudeMdContent = renderClaudeMd(instructions, artifacts.length > 0)
  const claudeMdPath = join(CLAUDE_DIR, CLAUDE_MD)
  await writeFileWithHash(workspace, claudeMdPath, claudeMdContent, manifest)

  // 2. Render path-scoped rules
  for (const rule of rules) {
    const ruleName = sanitizeName(rule.name)
    const rulePath = join(CLAUDE_DIR, RULES_DIR, `${ruleName}.md`)
    const ruleContent = renderRule(rule)
    await writeFileWithHash(workspace, rulePath, ruleContent, manifest)
  }

  // 3. Render skills
  for (const skill of skills) {
    const skillName = sanitizeName(skill.name)
    const skillDir = join(CLAUDE_DIR, SKILLS_DIR, skillName)
    await mkdir(join(workspace, skillDir), { recursive: true })

    const skillPath = join(skillDir, SKILL_FILE)
    const skillContent =
      typeof skill.content === 'string' ? skill.content : skill.content.toString('utf8')
    await writeFileWithHash(workspace, skillPath, skillContent, manifest)
  }

  // 4. Render settings.json
  const settingsContent = renderSettings(flow)
  const settingsPath = join(CLAUDE_DIR, SETTINGS_JSON)
  await writeFileWithHash(workspace, settingsPath, settingsContent, manifest)

  // 5. Write artifacts
  for (const artifact of artifacts) {
    const ext = inferExtension(artifact.mimeType, artifact.name)
    const artifactName = sanitizeName(artifact.name)
    const artifactPath = join(ARTIFACTS_DIR, `${artifactName}${ext}`)
    const content =
      typeof artifact.content === 'string' ? artifact.content : artifact.content.toString('utf8')
    await writeFileWithHash(workspace, artifactPath, content, manifest, {
      inherited: artifact.scope !== 'process',
    })
  }

  // 6. Seed declared artifacts (empty placeholders)
  if (declaredArtifacts) {
    for (const [name, meta] of Object.entries(declaredArtifacts)) {
      const ext = inferExtension(meta.mimeType, name)
      const artifactName = sanitizeName(name)
      const artifactPath = join(ARTIFACTS_DIR, `${artifactName}${ext}`)

      // Only seed if not already written
      if (!manifest.files.has(artifactPath)) {
        const placeholder = createPlaceholder(name, meta.mimeType, meta.label)
        await writeFileWithHash(workspace, artifactPath, placeholder, manifest, {
          seeded: true,
        })
      }
    }
  }

  return manifest
}

/**
 * Clean up provisioned files from a workspace.
 *
 * @param workspace - Workspace path
 * @param manifest - Manifest of provisioned files to remove
 */
export async function cleanupProvisionedFiles(
  workspace: string,
  manifest: ProvisionManifest,
): Promise<void> {
  for (const relativePath of manifest.files.keys()) {
    try {
      await rm(join(workspace, relativePath), { force: true })
    } catch {
      // Ignore errors - file may already be gone
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render CLAUDE.md from instruction context items.
 *
 * @param instructions - Instruction context items
 * @param hasArtifacts - Whether there are artifacts to reference
 * @returns CLAUDE.md content
 */
export function renderClaudeMd(instructions: ProvisioningItem[], hasArtifacts = false): string {
  const sections: string[] = []

  // Group instructions by scope for organization
  const systemInstructions = instructions.filter((i) => i.scope === 'system')
  const flowInstructions = instructions.filter((i) => i.scope === 'flow')
  const areaInstructions = instructions.filter((i) => i.scope === 'area')
  const processInstructions = instructions.filter((i) => i.scope === 'process')

  // System-level instructions
  if (systemInstructions.length > 0) {
    sections.push('# System Instructions\n')
    for (const inst of systemInstructions) {
      const content =
        typeof inst.content === 'string' ? inst.content : inst.content.toString('utf8')
      // Strip any existing top-level heading to avoid duplication
      const stripped = content.replace(/^#\s+[^\n]+\n+/, '')
      sections.push(stripped.trim())
      sections.push('')
    }
  }

  // Flow-level instructions
  if (flowInstructions.length > 0) {
    sections.push('# Flow Instructions\n')
    for (const inst of flowInstructions) {
      const content =
        typeof inst.content === 'string' ? inst.content : inst.content.toString('utf8')
      const stripped = content.replace(/^#\s+[^\n]+\n+/, '')
      sections.push(stripped.trim())
      sections.push('')
    }
  }

  // Area-level instructions
  if (areaInstructions.length > 0) {
    sections.push('# Area Instructions\n')
    for (const inst of areaInstructions) {
      const content =
        typeof inst.content === 'string' ? inst.content : inst.content.toString('utf8')
      const stripped = content.replace(/^#\s+[^\n]+\n+/, '')
      sections.push(stripped.trim())
      sections.push('')
    }
  }

  // Process-level instructions
  if (processInstructions.length > 0) {
    sections.push('# Process Instructions\n')
    for (const inst of processInstructions) {
      const content =
        typeof inst.content === 'string' ? inst.content : inst.content.toString('utf8')
      const stripped = content.replace(/^#\s+[^\n]+\n+/, '')
      sections.push(stripped.trim())
      sections.push('')
    }
  }

  // Working documents reference
  if (hasArtifacts) {
    sections.push('# Working Documents\n')
    sections.push(
      'Your working documents are in `.artifacts/`. Read them for context from prior turns.',
    )
    sections.push('Write to them to produce durable outputs that persist across turns.')
    sections.push('')
  }

  return sections.join('\n').trim() + '\n'
}

/**
 * Render a path-scoped rule with frontmatter.
 *
 * @param rule - Rule context item
 * @returns Rule file content with paths: frontmatter
 */
export function renderRule(rule: ProvisioningItem): string {
  const content = typeof rule.content === 'string' ? rule.content : rule.content.toString('utf8')

  // Check if content already has frontmatter
  if (content.startsWith('---\n')) {
    // Content already has frontmatter - ensure paths: is present
    if (!content.includes('paths:') && rule.pathScope) {
      // Insert paths: after the opening ---
      const insertPoint = content.indexOf('\n') + 1
      return (
        content.slice(0, insertPoint) + `paths: ${rule.pathScope}\n` + content.slice(insertPoint)
      )
    }
    return content
  }

  // Add frontmatter with paths:
  if (rule.pathScope) {
    return `---\npaths: ${rule.pathScope}\n---\n\n${content}`
  }

  return content
}

/**
 * Render settings.json for Claude Code.
 *
 * @param flow - Flow configuration with permissions
 * @returns Settings.json content
 */
export function renderSettings(flow?: {
  allowedTools?: string[]
  disallowedTools?: string[]
}): string {
  const settings: ClaudeSettings = {}

  if (flow?.allowedTools || flow?.disallowedTools) {
    settings.permissions = {}

    if (flow.allowedTools && flow.allowedTools.length > 0) {
      settings.permissions.allow = flow.allowedTools
    }

    if (flow.disallowedTools && flow.disallowedTools.length > 0) {
      settings.permissions.deny = flow.disallowedTools
    }
  }

  return JSON.stringify(settings, null, 2) + '\n'
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Write a file and record it in the manifest with its hash. */
async function writeFileWithHash(
  workspace: string,
  relativePath: string,
  content: string,
  manifest: ProvisionManifest,
  extra?: { inherited?: boolean; seeded?: boolean },
): Promise<void> {
  const fullPath = join(workspace, relativePath)
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content, 'utf8')

  const hash = createHash('sha256').update(content).digest('hex')
  const fileInfo: ProvisionedFile = { hash }

  if (extra?.inherited) fileInfo.inherited = true
  if (extra?.seeded) fileInfo.seeded = true

  manifest.files.set(relativePath, fileInfo)
}

/** Sanitize a name for use as a filename. */
function sanitizeName(name: string): string {
  // Remove path prefixes like "inherited/"
  const baseName = name.split('/').pop() ?? name

  // Remove extension if present
  const withoutExt = baseName.replace(/\.(md|json|ya?ml|txt)$/i, '')

  // Replace invalid characters
  return withoutExt.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-')
}

/** Infer file extension from MIME type. */
function inferExtension(mimeType: string, name?: string): string {
  // First check if name already has an extension
  if (name) {
    const ext = extname(name)
    if (ext) return ext
  }

  // Infer from MIME type
  const mimeMap: Record<string, string> = {
    'text/markdown': '.md',
    'text/plain': '.txt',
    'application/json': '.json',
    'application/yaml': '.yaml',
    'text/yaml': '.yaml',
    'text/html': '.html',
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'text/typescript': '.ts',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
  }

  return mimeMap[mimeType] ?? '.txt'
}

/** Create a placeholder for a declared artifact. */
function createPlaceholder(name: string, mimeType: string, label?: string): string {
  if (mimeType === 'application/json') {
    return '{}'
  }

  if (mimeType.startsWith('text/')) {
    const header = label ? `# ${label}` : `# ${name}`
    return `${header}\n\n<!-- This artifact will be populated during execution -->\n`
  }

  return ''
}
