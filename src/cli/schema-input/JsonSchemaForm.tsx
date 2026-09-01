// @ts-ignore
import { Box, Text, useInput } from 'ink'
// @ts-ignore
import TextInput from 'ink-text-input'
import React, { useState, useCallback, useMemo, useEffect } from 'react'

import type { FieldDescriptor } from './inspect'

import { getDefaultValue } from './inspect'

interface Props {
  fields: FieldDescriptor[]
  onSubmit: (value: Record<string, unknown>) => void
  onCancel?: () => void
}

interface NavigableSlot {
  type: 'field' | 'add_item'
  field?: FieldDescriptor
  parentFieldName?: string
  arrayIndex?: number
}

function buildSlots(fields: FieldDescriptor[], values: Record<string, unknown>): NavigableSlot[] {
  const slots: NavigableSlot[] = []
  for (const field of fields) {
    if (field.kind === 'literal') continue
    if (field.kind === 'array' && field.arrayItemFields) {
      const arr = (values[field.name] as unknown[]) ?? []
      for (let i = 0; i < arr.length; i++) {
        for (const subField of field.arrayItemFields) {
          if (subField.kind === 'literal') continue
          slots.push({
            type: 'field',
            field: subField,
            parentFieldName: field.name,
            arrayIndex: i,
          })
        }
      }
      slots.push({ type: 'add_item', parentFieldName: field.name })
    } else {
      slots.push({ type: 'field', field })
    }
  }
  return slots
}

function slotKey(slot: NavigableSlot): string {
  if (slot.type === 'add_item') return `add:${slot.parentFieldName}`
  if (slot.parentFieldName !== undefined && slot.arrayIndex !== undefined && slot.field) {
    return `${slot.parentFieldName}[${slot.arrayIndex}].${slot.field.name}`
  }
  return slot.field?.name ?? ''
}

export function JsonSchemaForm({ fields, onSubmit, onCancel }: Props): React.ReactElement {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, getDefaultValue(f)])),
  )

  const slots = useMemo(() => buildSlots(fields, values), [fields, values])
  const [focusIdx, setFocusIdx] = useState(0)

  const slotIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    for (let i = 0; i < slots.length; i++) {
      map.set(slotKey(slots[i]), i)
    }
    return map
  }, [slots])

  useEffect(() => {
    if (focusIdx >= slots.length) {
      setFocusIdx(Math.max(0, slots.length - 1))
    }
  }, [slots.length, focusIdx])

  const setSlotValue = useCallback(
    (fieldName: string, value: unknown, parentFieldName?: string, arrayIndex?: number) => {
      if (parentFieldName !== undefined && arrayIndex !== undefined) {
        setValues((prev) => {
          const arr = [...((prev[parentFieldName] as Record<string, unknown>[]) ?? [])]
          arr[arrayIndex] = { ...arr[arrayIndex], [fieldName]: value }
          return { ...prev, [parentFieldName]: arr }
        })
      } else {
        setValues((prev) => ({ ...prev, [fieldName]: value }))
      }
    },
    [],
  )

  const addArrayItem = useCallback(
    (fieldName: string) => {
      const field = fields.find((f) => f.name === fieldName)
      if (!field?.arrayItemFields) return
      const newItem = Object.fromEntries(
        field.arrayItemFields.map((f) => [f.name, getDefaultValue(f)]),
      )
      setValues((prev) => {
        const arr = [...((prev[fieldName] as unknown[]) ?? [])]
        arr.push(newItem)
        return { ...prev, [fieldName]: arr }
      })
    },
    [fields],
  )

  const removeLastArrayItem = useCallback((fieldName: string) => {
    setValues((prev) => {
      const arr = [...((prev[fieldName] as unknown[]) ?? [])]
      if (arr.length <= 0) return prev
      arr.pop()
      return { ...prev, [fieldName]: arr }
    })
  }, [])

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.()
      return
    }

    const focused = slots[focusIdx]

    if (focused?.type === 'add_item' && focused.parentFieldName) {
      if (input === 'a') {
        addArrayItem(focused.parentFieldName)
        return
      }
      if (input === 'r') {
        const arr = (values[focused.parentFieldName] as unknown[]) ?? []
        if (arr.length > 0) {
          removeLastArrayItem(focused.parentFieldName)
        }
        return
      }
    }

    if (key.return) {
      const result: Record<string, unknown> = {}
      for (const f of fields) {
        const v = values[f.name]
        if (v !== undefined && v !== '') result[f.name] = v
        else if (f.required) result[f.name] = getDefaultValue(f)
      }
      onSubmit(result)
      return
    }

    if (key.upArrow) {
      setFocusIdx((i) => (i > 0 ? i - 1 : slots.length - 1))
      return
    }
    if (key.downArrow) {
      setFocusIdx((i) => (i < slots.length - 1 ? i + 1 : 0))
      return
    }

    if (!focused || focused.type !== 'field' || !focused.field) return

    const val =
      focused.parentFieldName !== undefined && focused.arrayIndex !== undefined
        ? (values[focused.parentFieldName] as Record<string, unknown>[])?.[focused.arrayIndex]?.[
            focused.field.name
          ]
        : values[focused.field.name]

    if (focused.field.kind === 'boolean') {
      if (key.leftArrow || key.rightArrow || input === ' ') {
        setSlotValue(focused.field.name, !val, focused.parentFieldName, focused.arrayIndex)
      }
      if (input === 't' || input === 'y')
        setSlotValue(focused.field.name, true, focused.parentFieldName, focused.arrayIndex)
      if (input === 'f' || input === 'n')
        setSlotValue(focused.field.name, false, focused.parentFieldName, focused.arrayIndex)
    }

    if (focused.field.kind === 'enum' && focused.field.enumValues) {
      const opts = focused.field.enumValues
      const idx = opts.indexOf(val as string)
      if (key.leftArrow)
        setSlotValue(
          focused.field.name,
          opts[idx > 0 ? idx - 1 : opts.length - 1],
          focused.parentFieldName,
          focused.arrayIndex,
        )
      if (key.rightArrow)
        setSlotValue(
          focused.field.name,
          opts[idx < opts.length - 1 ? idx + 1 : 0],
          focused.parentFieldName,
          focused.arrayIndex,
        )
    }
  })

  return (
    <Box flexDirection="column">
      <Text dimColor>{'{'}</Text>
      {fields.map((field, fieldIdx) => {
        const isLastField = fieldIdx === fields.length - 1

        if (field.kind === 'array' && field.arrayItemFields) {
          const arr = (values[field.name] as Record<string, unknown>[]) ?? []
          const subFields = field.arrayItemFields
          const addSlotIdx = slotIndexMap.get(`add:${field.name}`)
          const isAddFocused = addSlotIdx === focusIdx

          return (
            <React.Fragment key={field.name}>
              <Box>
                <Text> </Text>
                <Text>"{field.name}"</Text>
                <Text dimColor>: [</Text>
              </Box>
              {arr.map((item, ai) => {
                const isLastItem = ai === arr.length - 1
                return (
                  <React.Fragment key={ai}>
                    <Box>
                      <Text> </Text>
                      <Text dimColor>{'{'}</Text>
                    </Box>
                    {subFields.map((subField, si) => {
                      const isLastSub = si === subFields.length - 1

                      if (subField.kind === 'literal') {
                        return (
                          <Box key={subField.name}>
                            <Text> </Text>
                            <Text>"{subField.name}"</Text>
                            <Text dimColor>: </Text>
                            <Text color="magentaBright">
                              {JSON.stringify(subField.literalValue)}
                            </Text>
                            {!isLastSub && <Text dimColor>,</Text>}
                          </Box>
                        )
                      }

                      const sKey = `${field.name}[${ai}].${subField.name}`
                      const slotIdx = slotIndexMap.get(sKey)
                      const isFocused = slotIdx === focusIdx
                      const val = item[subField.name]

                      return (
                        <Box key={subField.name}>
                          <Text> </Text>
                          <Text color={isFocused ? 'yellowBright' : 'white'}>
                            "{subField.name}"
                          </Text>
                          <Text dimColor>: </Text>
                          <FieldValue
                            field={subField}
                            value={val}
                            focused={isFocused}
                            onChange={(v) => setSlotValue(subField.name, v, field.name, ai)}
                          />
                          {!isLastSub && <Text dimColor>,</Text>}
                        </Box>
                      )
                    })}
                    <Box>
                      <Text> </Text>
                      <Text dimColor>
                        {'}'}
                        {isLastItem ? '' : ','}
                      </Text>
                    </Box>
                  </React.Fragment>
                )
              })}
              <Box>
                <Text> </Text>
                <Text color={isAddFocused ? 'yellowBright' : 'gray'}>
                  {isAddFocused
                    ? arr.length > 0
                      ? '▸ add [a] | remove [r]'
                      : '▸ add [a]'
                    : arr.length > 0
                      ? '+ add | remove'
                      : '+ add'}
                </Text>
              </Box>
              <Box>
                <Text> </Text>
                <Text dimColor>]{isLastField ? '' : ','}</Text>
              </Box>
            </React.Fragment>
          )
        }

        if (field.kind === 'literal') {
          return (
            <Box key={field.name}>
              <Text> </Text>
              <Text>"{field.name}"</Text>
              <Text dimColor>: </Text>
              <Text color="magentaBright">{JSON.stringify(field.literalValue)}</Text>
              {!isLastField && <Text dimColor>,</Text>}
            </Box>
          )
        }

        const slotIdx = slotIndexMap.get(field.name)
        const isFocused = slotIdx === focusIdx

        return (
          <Box key={field.name}>
            <Text> </Text>
            <Text color={isFocused ? 'yellowBright' : 'white'}>"{field.name}"</Text>
            <Text dimColor>: </Text>
            <FieldValue
              field={field}
              value={values[field.name]}
              focused={isFocused}
              onChange={(v) => setSlotValue(field.name, v)}
            />
            {!isLastField && <Text dimColor>,</Text>}
            {!field.required && <Text dimColor> ?</Text>}
          </Box>
        )
      })}
      <Text dimColor>{'}'}</Text>
    </Box>
  )
}

function FieldValue({
  field,
  value,
  focused,
  onChange,
}: {
  field: FieldDescriptor
  value: unknown
  focused: boolean
  onChange: (v: unknown) => void
}): React.ReactElement {
  if (field.kind === 'boolean') {
    const v = value as boolean
    return (
      <Text>
        <Text color={v ? 'greenBright' : 'gray'}>{v ? '●' : '○'}</Text>
        <Text color={focused ? 'yellowBright' : undefined}> true </Text>
        <Text color={!v ? 'redBright' : 'gray'}>{!v ? '●' : '○'}</Text>
        <Text color={focused ? 'yellowBright' : undefined}> false</Text>
      </Text>
    )
  }

  if (field.kind === 'enum' && field.enumValues) {
    const opts = field.enumValues
    if (opts.length <= 4) {
      return (
        <Text>
          {opts.map((opt, i) => (
            <Text key={opt}>
              <Text color={opt === value ? 'greenBright' : 'gray'}>
                {opt === value ? '●' : '○'}
              </Text>
              <Text color={focused && opt === value ? 'yellowBright' : undefined}> {opt}</Text>
              {i < opts.length - 1 && <Text> </Text>}
            </Text>
          ))}
        </Text>
      )
    }
    const idx = opts.indexOf(value as string)
    return (
      <Text color={focused ? 'yellowBright' : 'greenBright'}>
        "{String(value)}"{' '}
        <Text dimColor>
          ({idx + 1}/{opts.length})
        </Text>
      </Text>
    )
  }

  if (field.kind === 'string') {
    if (!focused) return <Text color="greenBright">"{String(value || '')}"</Text>
    return (
      <Box>
        <Text color="greenBright">"</Text>
        <TextInput
          value={(value as string) || ''}
          onChange={onChange}
          placeholder={field.description}
        />
        <Text color="greenBright">"</Text>
      </Box>
    )
  }

  if (field.kind === 'number') {
    if (!focused) return <Text color="cyanBright">{String(value ?? 0)}</Text>
    return (
      <TextInput
        value={String(value ?? 0)}
        onChange={(t) => {
          const n = parseFloat(t)
          if (!isNaN(n)) onChange(n)
        }}
      />
    )
  }

  if (field.kind === 'literal') {
    return <Text color="magentaBright">{JSON.stringify(field.literalValue)}</Text>
  }

  return <Text dimColor>{'<unsupported>'}</Text>
}
