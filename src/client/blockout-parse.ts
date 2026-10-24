// BlockoutCard 的纯解析逻辑（无 React）：从 tool block 取参数、结果文本，
// 再从「首行 header + 引擎 JSON + 追加说明」里拆出结构化数据。可单独单测。
export const BLOCKOUT_ACTIONS = ['check', 'describe', 'sheet', 'view', 'shot', 'shots', 'video'] as const
export type BlockoutActionName = (typeof BLOCKOUT_ACTIONS)[number]

export type JsonRecord = Record<string, unknown>

/** preparing/start 用 argsRaw，result 用 call.argsRaw；半截 JSON 返回空对象 */
export function parseCallArgs(block: unknown): JsonRecord {
  if (!block || typeof block !== 'object') return {}
  const rec = block as JsonRecord
  const call = rec.call as JsonRecord | undefined
  const raw = rec.kind !== undefined ? call?.argsRaw : rec.argsRaw
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
  } catch {
    return {}
  }
}

export function readResultText(block: unknown): string {
  if (!block || typeof block !== 'object') return ''
  const content = (block as JsonRecord).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

/** 从首个 `{` 起按字符串/转义/括号深度截出完整 JSON 对象 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export interface ParsedEngineResult {
  header: string
  data: JsonRecord | null
  trailing: string
}

export function parseEngineResult(text: string): ParsedEngineResult {
  const newline = text.indexOf('\n')
  const header = newline >= 0 ? text.slice(0, newline) : text
  const body = newline >= 0 ? text.slice(newline + 1) : ''
  const jsonText = extractJsonObject(body)
  let data: JsonRecord | null = null
  if (jsonText !== null) {
    try {
      const parsed = JSON.parse(jsonText)
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : null
    } catch {
      data = null
    }
  }
  const trailing = jsonText !== null ? body.slice(body.indexOf(jsonText) + jsonText.length).trim() : body.trim()
  return { header, data, trailing }
}

export function resolveAction(args: JsonRecord, header: string): BlockoutActionName | '' {
  const fromArgs = typeof args.action === 'string' ? args.action : ''
  if ((BLOCKOUT_ACTIONS as readonly string[]).includes(fromArgs)) return fromArgs as BlockoutActionName
  const match = /·\s*(check|describe|sheet|view|shot|shots|video)\b/.exec(header)
  return (match?.[1] as BlockoutActionName | undefined) ?? ''
}

export function issueMessages(items: unknown, max = 3): string[] {
  if (!Array.isArray(items)) return []
  return items.slice(0, max).map((item) => {
    let text: string
    if (typeof item === 'string') text = item
    else if (item && typeof item === 'object') {
      const rec = item as JsonRecord
      const code = typeof rec.code === 'string' ? rec.code : ''
      const message = typeof rec.message === 'string' ? rec.message : JSON.stringify(item)
      text = code ? `${code}: ${message}` : message
    } else text = String(item)
    return text.length > 220 ? `${text.slice(0, 220)}…` : text
  })
}

export function truncateText(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text
}

export function formatNumber(value: unknown, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(digits))) : '—'
}

export function formatRange(value: unknown, digits = 2): string {
  if (!Array.isArray(value) || value.length < 2) return '—'
  const [min, max] = value
  if (typeof min !== 'number' || typeof max !== 'number') return '—'
  return `${Number(min.toFixed(digits))}–${Number(max.toFixed(digits))}`
}
