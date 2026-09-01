/**
 * Knowledge Module
 *
 * Shared types and provisioning helpers for the Fab's knowledge layer.
 *
 * @module
 */

// Types
export type {
  KnowledgeSourceType,
  KnowledgeScope,
  KnowledgeAuthority,
  KnowledgeType,
  ProvisioningItem,
  ProvisionedFile,
  ProvisionManifest,
  KnowledgeEntry,
  CreateKnowledgeInput,
  ProvisionOptions,
  ClaudeSettings,
} from './types'

// Claude Provisioner
export {
  provisionClaudeProtocol,
  renderClaudeMd,
  renderRule,
  renderSettings,
} from './claude-provisioner'
