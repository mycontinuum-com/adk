import { z as z3 } from 'zod/v3'
import { z as z4 } from 'zod/v4'

import type { ZodOutput, ZodSchema } from './zod'

declare function inferOutput<S extends ZodSchema>(schema: S): ZodOutput<S>

const fromV3 = inferOutput(z3.string().transform((value) => value.length))
const fromV4 = inferOutput(z4.string().transform((value) => value.length))

const v3Number: number = fromV3
const v4Number: number = fromV4
void v3Number
void v4Number

// @ts-expect-error transformed outputs must not widen
const wrongV3: string = fromV3
// @ts-expect-error transformed outputs must not widen
const wrongV4: string = fromV4
void wrongV3
void wrongV4
