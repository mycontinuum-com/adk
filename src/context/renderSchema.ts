import type { z } from 'zod';

type ZodDef = {
  typeName?: string;
  description?: string;
  value?: unknown;
  values?: unknown[];
  type?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  valueType?: z.ZodType;
  shape?: () => Record<string, z.ZodType>;
  getter?: () => z.ZodType;
};

type ShapeFn = () => Record<string, z.ZodType>;
type Identity = z.ZodType | ShapeFn;

interface RenderContext {
  refs: Map<Identity, string>;
  rendering: Set<Identity>;
  reused: Set<Identity>;
  counter: number;
}

function getDef(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def ?? {};
}

function getIdentity(schema: z.ZodType): Identity {
  const d = getDef(schema);
  if (d.typeName === 'ZodObject' && d.shape) return d.shape;
  return schema;
}

function findReused(schema: z.ZodType): Set<Identity> {
  const counts = new Map<Identity, number>();
  const reused = new Set<Identity>();
  const stack = new Set<Identity>();

  function visit(s: z.ZodType): void {
    const d = getDef(s);
    const isObject = d.typeName === 'ZodObject';
    const isLazy = d.typeName === 'ZodLazy';
    const id = getIdentity(s);

    if (isObject || isLazy) {
      if (stack.has(id)) {
        reused.add(id);
        return;
      }
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (count > 1) {
        reused.add(id);
        return;
      }
      stack.add(id);
    }

    if (isLazy && d.getter) {
      visit(d.getter());
    } else if (isObject && d.shape) {
      for (const val of Object.values(d.shape())) {
        visit(val as z.ZodType);
      }
    } else if (d.type) {
      visit(d.type);
    } else if (d.innerType) {
      visit(d.innerType);
    }

    if (isObject || isLazy) {
      stack.delete(id);
    }
  }

  visit(schema);
  return reused;
}

function getTypeName(schema: z.ZodType, ctx: RenderContext): string {
  const d = getDef(schema);
  const t = d.typeName;
  const id = getIdentity(schema);

  if (t === 'ZodString') return 'string';
  if (t === 'ZodNumber') return 'number';
  if (t === 'ZodBoolean') return 'boolean';
  if (t === 'ZodNull') return 'null';
  if (t === 'ZodUndefined') return 'undefined';
  if (t === 'ZodLiteral') return JSON.stringify(d.value);
  if (t === 'ZodEnum')
    return (d.values ?? []).map((v) => JSON.stringify(v)).join(' | ');
  if (t === 'ZodNativeEnum') return 'enum';
  if (t === 'ZodRecord' && d.valueType)
    return `Record<string, ${getTypeName(d.valueType, ctx)}>`;
  if (t === 'ZodDefault' && d.innerType) return getTypeName(d.innerType, ctx);
  if (t === 'ZodNullable' && d.innerType)
    return `${getTypeName(d.innerType, ctx)} | null`;
  if (t === 'ZodOptional' && d.innerType) return getTypeName(d.innerType, ctx);
  if (t === 'ZodUnion' && d.options)
    return d.options.map((o) => getTypeName(o, ctx)).join(' | ');
  if (t === 'ZodArray' && d.type) {
    const innerId = getIdentity(d.type);
    if (ctx.refs.has(innerId)) return `Array<${ctx.refs.get(innerId)}>`;
    return `${getTypeName(d.type, ctx)}[]`;
  }
  if ((t === 'ZodObject' || t === 'ZodLazy') && ctx.refs.has(id)) {
    return ctx.refs.get(id)!;
  }

  return 'unknown';
}

function render(schema: z.ZodType, indent: number, ctx: RenderContext): string {
  const d = getDef(schema);
  const pad = '  '.repeat(indent);
  const id = getIdentity(schema);

  if (ctx.refs.has(id)) {
    return ctx.refs.get(id)!;
  }

  if (d.typeName === 'ZodLazy') {
    if (ctx.rendering.has(id)) {
      const name = `T${++ctx.counter}`;
      ctx.refs.set(id, name);
      return name;
    }
    const needsRef = ctx.reused.has(id);
    const refName = needsRef ? `T${++ctx.counter}` : undefined;
    if (refName) ctx.refs.set(id, refName);

    ctx.rendering.add(id);
    const inner = d.getter ? d.getter() : schema;
    const result = render(inner, indent, ctx);
    ctx.rendering.delete(id);

    if (refName && !result.startsWith('{ #')) {
      return result.replace('{', `{ #${refName}`);
    }
    return result;
  }

  if (d.typeName !== 'ZodObject') {
    return getTypeName(schema, ctx);
  }

  if (ctx.rendering.has(id)) {
    const name = `T${++ctx.counter}`;
    ctx.refs.set(id, name);
    return name;
  }

  const needsRef = ctx.reused.has(id);
  const refName = needsRef ? `T${++ctx.counter}` : undefined;
  if (refName) ctx.refs.set(id, refName);

  ctx.rendering.add(id);
  const shape = d.shape?.() ?? {};
  const lines: string[] = [refName ? `{ #${refName}` : '{'];

  for (const [key, value] of Object.entries(shape)) {
    const fieldDef = getDef(value as z.ZodType);
    const isOpt = fieldDef.typeName === 'ZodOptional';
    const inner =
      isOpt && fieldDef.innerType ? fieldDef.innerType : (value as z.ZodType);
    const innerDef = getDef(inner);
    const innerId = getIdentity(inner);

    if (fieldDef.description) {
      lines.push(`${pad}  // ${fieldDef.description}`);
    }

    const isComplex =
      innerDef.typeName === 'ZodObject' || innerDef.typeName === 'ZodLazy';
    const isArrayOfComplex =
      innerDef.typeName === 'ZodArray' &&
      innerDef.type &&
      ['ZodObject', 'ZodLazy'].includes(getDef(innerDef.type).typeName ?? '');

    if (isComplex || isArrayOfComplex) {
      let rendered: string;
      if (isArrayOfComplex && innerDef.type) {
        const arrayInnerId = getIdentity(innerDef.type);
        const innerRendered = ctx.refs.has(arrayInnerId)
          ? ctx.refs.get(arrayInnerId)!
          : render(innerDef.type, indent + 1, ctx);
        rendered = `Array<${innerRendered}>`;
      } else {
        rendered = ctx.refs.has(innerId)
          ? ctx.refs.get(innerId)!
          : render(inner, indent + 1, ctx);
      }
      lines.push(`${pad}  ${key}${isOpt ? '?' : ''}: ${rendered}`);
    } else {
      lines.push(`${pad}  ${key}: ${getTypeName(value as z.ZodType, ctx)}`);
    }
  }

  ctx.rendering.delete(id);
  lines.push(`${pad}}`);
  return lines.join('\n');
}

export function renderSchema(schema: z.ZodType, indent = 0): string {
  const ctx: RenderContext = {
    refs: new Map(),
    rendering: new Set(),
    reused: findReused(schema),
    counter: 0,
  };
  return render(schema, indent, ctx);
}
