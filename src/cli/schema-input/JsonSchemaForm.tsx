import React, { useState, useCallback, useMemo } from 'react';
// @ts-ignore
import { Box, Text, useInput } from 'ink';
// @ts-ignore
import TextInput from 'ink-text-input';
import type { FieldDescriptor } from './inspect';
import { getDefaultValue } from './inspect';

interface Props {
  fields: FieldDescriptor[];
  onSubmit: (value: Record<string, unknown>) => void;
  onCancel?: () => void;
}

export function JsonSchemaForm({ fields, onSubmit, onCancel }: Props): React.ReactElement {
  const editableFields = useMemo(() => fields.filter(f => f.kind !== 'literal'), [fields]);
  const [focusIdx, setFocusIdx] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fields.map(f => [f.name, getDefaultValue(f)]))
  );

  const focused = editableFields[focusIdx];

  const setValue = useCallback((name: string, value: unknown) => {
    setValues(prev => ({ ...prev, [name]: value }));
  }, []);

  useInput((input, key) => {
    if (key.escape) { onCancel?.(); return; }
    if (key.return) {
      const result: Record<string, unknown> = {};
      for (const f of fields) {
        const v = values[f.name];
        if (v !== undefined && v !== '') result[f.name] = v;
        else if (f.required) result[f.name] = getDefaultValue(f);
      }
      onSubmit(result);
      return;
    }

    if (key.upArrow) { setFocusIdx(i => i > 0 ? i - 1 : editableFields.length - 1); return; }
    if (key.downArrow) { setFocusIdx(i => i < editableFields.length - 1 ? i + 1 : 0); return; }

    if (!focused) return;
    const val = values[focused.name];

    if (focused.kind === 'boolean') {
      if (key.leftArrow || key.rightArrow || input === ' ') setValue(focused.name, !val);
      if (input === 't' || input === 'y') setValue(focused.name, true);
      if (input === 'f' || input === 'n') setValue(focused.name, false);
    }

    if (focused.kind === 'enum' && focused.enumValues) {
      const opts = focused.enumValues;
      const idx = opts.indexOf(val as string);
      if (key.leftArrow) setValue(focused.name, opts[idx > 0 ? idx - 1 : opts.length - 1]);
      if (key.rightArrow) setValue(focused.name, opts[idx < opts.length - 1 ? idx + 1 : 0]);
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>{'{'}</Text>
      {fields.map((field, idx) => {
        const isFocused = focused?.name === field.name;
        const isLast = idx === fields.length - 1;
        return (
          <Box key={field.name}>
            <Text>  </Text>
            <Text color={isFocused ? 'yellowBright' : 'white'}>"{field.name}"</Text>
            <Text dimColor>: </Text>
            <FieldValue field={field} value={values[field.name]} focused={isFocused} onChange={v => setValue(field.name, v)} />
            {!isLast && <Text dimColor>,</Text>}
            {!field.required && <Text dimColor> ?</Text>}
          </Box>
        );
      })}
      <Text dimColor>{'}'}</Text>
      <Box marginTop={1}>
        <Text dimColor>[↑↓] field • [←→] value • [Enter] submit • [Esc] cancel</Text>
      </Box>
    </Box>
  );
}

function FieldValue({ field, value, focused, onChange }: {
  field: FieldDescriptor;
  value: unknown;
  focused: boolean;
  onChange: (v: unknown) => void;
}): React.ReactElement {
  if (field.kind === 'boolean') {
    const v = value as boolean;
    return (
      <Text>
        <Text color={v ? 'greenBright' : 'gray'}>{v ? '●' : '○'}</Text>
        <Text color={focused ? 'yellowBright' : undefined}> true </Text>
        <Text color={!v ? 'redBright' : 'gray'}>{!v ? '●' : '○'}</Text>
        <Text color={focused ? 'yellowBright' : undefined}> false</Text>
      </Text>
    );
  }

  if (field.kind === 'enum' && field.enumValues) {
    const opts = field.enumValues;
    if (opts.length <= 4) {
      return (
        <Text>
          {opts.map((opt, i) => (
            <Text key={opt}>
              <Text color={opt === value ? 'greenBright' : 'gray'}>{opt === value ? '●' : '○'}</Text>
              <Text color={focused && opt === value ? 'yellowBright' : undefined}> {opt}</Text>
              {i < opts.length - 1 && <Text> </Text>}
            </Text>
          ))}
        </Text>
      );
    }
    const idx = opts.indexOf(value as string);
    return <Text color={focused ? 'yellowBright' : 'greenBright'}>"{value}" <Text dimColor>({idx + 1}/{opts.length})</Text></Text>;
  }

  if (field.kind === 'string') {
    if (!focused) return <Text color="greenBright">"{value || ''}"</Text>;
    return (
      <Box>
        <Text color="greenBright">"</Text>
        <TextInput value={(value as string) || ''} onChange={onChange} placeholder={field.description} />
        <Text color="greenBright">"</Text>
      </Box>
    );
  }

  if (field.kind === 'number') {
    if (!focused) return <Text color="cyanBright">{value ?? 0}</Text>;
    return <TextInput value={String(value ?? 0)} onChange={t => { const n = parseFloat(t); if (!isNaN(n)) onChange(n); }} />;
  }

  if (field.kind === 'literal') {
    return <Text color="magentaBright">{JSON.stringify(field.literalValue)}</Text>;
  }

  return <Text dimColor>{'<unsupported>'}</Text>;
}
