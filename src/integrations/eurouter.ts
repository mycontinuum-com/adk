import type { EurouterModel } from '../types/runnables'

import { ADAPTER } from '../core/adapter-symbol'
import { EurouterAdapter } from '../providers/eurouter'
import { eurouter as createModel } from '../providers/models'

export function eurouter(
  name: string,
  config?: Omit<EurouterModel, 'provider' | 'name'>,
): EurouterModel {
  const model = createModel(name, config)
  Object.defineProperty(model, ADAPTER, { value: () => new EurouterAdapter() })
  return model
}

export type { EurouterModel, EurouterRouting } from '../types/runnables'
export type { EurouterAdapterOptions } from '../providers/eurouter'
export { EurouterAdapter } from '../providers/eurouter'
