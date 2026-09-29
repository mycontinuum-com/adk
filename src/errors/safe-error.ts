/** An error as log fields that carry no patient data. */
export interface SafeErrorFields {
  errorName: string
}

/**
 * An error for a log line, without patient data: its class only. The message and the stack are
 * never included, because a message can repeat a caller's words, and no filter can tell a name such
 * as "Patient Okafor not found" from any other text.
 */
export function safeErrorFields(error: unknown): SafeErrorFields {
  if (!(error instanceof Error)) return { errorName: typeof error }
  // The class from the prototype chain: `name` and an own `constructor` can be set on the instance.
  const errorClass: unknown = Object.getPrototypeOf(error)?.constructor
  return { errorName: (typeof errorClass === 'function' && errorClass.name) || 'Error' }
}
