// @ts-ignore
import { Text } from 'ink'
import React from 'react'

export function renderJsonLine(
  text: string,
  keyColor: string,
  dimmed: boolean,
  skipHighlighting: boolean = false,
): React.ReactNode {
  if (!text) {
    return <Text dimColor={dimmed}> </Text>
  }

  if (skipHighlighting || !text.includes('":')) {
    return <Text dimColor={dimmed}>{text}</Text>
  }

  const parts: React.ReactNode[] = []
  const keyRegex = /("[\w_-]+")(:\s*)/g
  let lastIndex = 0
  let match
  let keyIndex = 0

  while ((match = keyRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Text key={`t${keyIndex}`} dimColor={dimmed}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      )
    }
    parts.push(
      <Text key={`k${keyIndex}`} color={keyColor} dimColor>
        {match[1]}
      </Text>,
    )
    parts.push(
      <Text key={`c${keyIndex}`} dimColor={dimmed}>
        {match[2]}
      </Text>,
    )
    lastIndex = keyRegex.lastIndex
    keyIndex++
  }

  if (lastIndex < text.length) {
    parts.push(
      <Text key={`t${keyIndex}`} dimColor={dimmed}>
        {text.slice(lastIndex)}
      </Text>,
    )
  }

  if (parts.length === 0) {
    return <Text dimColor={dimmed}>{text}</Text>
  }

  return <>{parts}</>
}

export function renderThoughtText(
  text: string,
  dimmed: boolean = true,
  skipHighlighting: boolean = false,
): React.ReactNode {
  if (!text) {
    return <Text dimColor={dimmed}> </Text>
  }

  if (skipHighlighting || !text.includes('**')) {
    return <Text dimColor={dimmed}>{text}</Text>
  }

  const parts: React.ReactNode[] = []
  const headingPattern = /\*\*([^*]+)\*\*/g
  let lastIndex = 0
  let match
  let keyIdx = 0

  while ((match = headingPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Text key={`t${keyIdx++}`} dimColor={dimmed}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      )
    }
    parts.push(<Text key={`h${keyIdx++}`}>{match[1]}</Text>)
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(
      <Text key={`t${keyIdx++}`} dimColor={dimmed}>
        {text.slice(lastIndex)}
      </Text>,
    )
  }

  if (parts.length === 0) {
    return <Text dimColor={dimmed}>{text}</Text>
  }

  return <>{parts}</>
}

export function renderToolCallLine(
  text: string,
  keyColor: string,
  dimmed: boolean = true,
  skipHighlighting: boolean = false,
): React.ReactNode {
  if (!text) {
    return <Text dimColor={dimmed}> </Text>
  }

  if (skipHighlighting) {
    return <Text dimColor={dimmed}>{text}</Text>
  }

  const spaceIdx = text.indexOf(' ')
  if (spaceIdx === -1) {
    return <Text dimColor={dimmed}>{text}</Text>
  }
  const toolName = text.slice(0, spaceIdx)
  const argsText = text.slice(spaceIdx + 1)
  return (
    <>
      <Text dimColor={dimmed}>{toolName} </Text>
      {renderJsonLine(argsText, keyColor, dimmed, skipHighlighting)}
    </>
  )
}

export function renderToolResultLine(
  text: string,
  keyColor: string,
  dimmed: boolean = true,
  skipHighlighting: boolean = false,
): React.ReactNode {
  if (!text) {
    return <Text dimColor={dimmed}> </Text>
  }

  if (skipHighlighting) {
    return <Text dimColor={dimmed}>{text}</Text>
  }

  const arrowIdx = text.indexOf(' → ')
  if (arrowIdx === -1) {
    const isJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[')
    if (isJson) {
      return renderJsonLine(text, keyColor, dimmed, skipHighlighting)
    }
    return <Text dimColor={dimmed}>{text}</Text>
  }
  const toolName = text.slice(0, arrowIdx)
  const resultText = text.slice(arrowIdx + 3)
  const isJson = resultText.trimStart().startsWith('{') || resultText.trimStart().startsWith('[')
  return (
    <>
      <Text dimColor={dimmed}>{toolName} → </Text>
      {isJson ? (
        renderJsonLine(resultText, keyColor, dimmed, skipHighlighting)
      ) : (
        <Text dimColor={dimmed}>{resultText}</Text>
      )}
    </>
  )
}

const stripJsonCache = new Map<string, string>()
const MAX_STRIP_CACHE_SIZE = 1000
const MAX_CACHEABLE_LENGTH = 10000

export function stripJsonNewlines(jsonStr: string): string {
  if (jsonStr.length > MAX_CACHEABLE_LENGTH) {
    return jsonStr.replace(/\s+/g, ' ').trim()
  }

  const cached = stripJsonCache.get(jsonStr)
  if (cached !== undefined) return cached

  let result: string
  try {
    const parsed = JSON.parse(jsonStr)
    result = JSON.stringify(parsed)
  } catch {
    result = jsonStr.replace(/\s+/g, ' ').trim()
  }

  if (stripJsonCache.size >= MAX_STRIP_CACHE_SIZE) {
    const firstKey = stripJsonCache.keys().next().value
    if (firstKey) stripJsonCache.delete(firstKey)
  }
  stripJsonCache.set(jsonStr, result)

  return result
}

export function formatThoughtTextMultiLine(text: string): string {
  return text.replace(/\n\n+/g, '\n').replace(/([^\n])\*\*([A-Z])/g, '$1\n**$2')
}
