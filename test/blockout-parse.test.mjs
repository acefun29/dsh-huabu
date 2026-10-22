import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  extractJsonObject,
  formatNumber,
  formatRange,
  issueMessages,
  parseCallArgs,
  parseEngineResult,
  readResultText,
  resolveAction,
} = await import('../lib/.blockout-parse.test.mjs')

test('parseCallArgs：result 取 call.argsRaw，start 取 argsRaw，半截 JSON 返回空对象', () => {
  assert.deepEqual(
    parseCallArgs({ kind: 'result', call: { argsRaw: '{"action":"sheet","scene":"a.json"}' } }),
    { action: 'sheet', scene: 'a.json' },
  )
  assert.deepEqual(parseCallArgs({ phase: 'start', argsRaw: '{"action":"check"}' }), { action: 'check' })
  assert.deepEqual(parseCallArgs({ phase: 'start', argsRaw: '{"action":"sh' }), {})
  assert.deepEqual(parseCallArgs(undefined), {})
  assert.deepEqual(parseCallArgs({ kind: 'result', call: { argsRaw: '[1,2]' } }), {})
})

test('readResultText：只拼接 text block', () => {
  const block = {
    content: [
      { type: 'text', text: '第一行' },
      { type: 'image', attachment: { attachmentId: 'sha256:x' } },
      { type: 'text', text: '第二行' },
    ],
  }
  assert.equal(readResultText(block), '第一行\n第二行')
  assert.equal(readResultText({}), '')
})

test('extractJsonObject：跳过字符串里的括号与转义', () => {
  const text = 'prefix {"a":"} not end","b":{"c":1}} suffix'
  assert.equal(extractJsonObject(text), '{"a":"} not end","b":{"c":1}}')
  assert.equal(extractJsonObject('no json'), null)
})

test('parseEngineResult：拆出 header / 引擎 JSON / 追加说明', () => {
  const data = {
    ok: true,
    image: 'C:\\ws\\.huabu\\blockout\\mini\\sheet.png',
    subject: { id: 'bottle', reason: '被支撑的装配体' },
    width: 1024,
    height: 1070,
    cells: [{ name: 'front', orthoHeight: 1.02 }],
  }
  const text = `[blockout engine v0.2.0-mvp · sheet]\n${JSON.stringify(data, null, 2)}\n成片已发布到素材库：assets/video/mini-hero.mp4（12KB）`
  const parsed = parseEngineResult(text)
  assert.match(parsed.header, /· sheet\]/)
  assert.equal(parsed.data?.ok, true)
  assert.equal(parsed.data?.subject.id, 'bottle')
  assert.match(parsed.trailing, /^成片已发布到素材库/)
})

test('parseEngineResult：非 JSON 结果保留 header，data 为 null', () => {
  const parsed = parseEngineResult('[blockout engine v0.2.0-mvp · check]\n不是 JSON')
  assert.match(parsed.header, /· check\]/)
  assert.equal(parsed.data, null)
  assert.equal(parsed.trailing, '不是 JSON')
})

test('resolveAction：优先 args，其次 header；非法值返回空串', () => {
  assert.equal(resolveAction({ action: 'sheet' }, ''), 'sheet')
  assert.equal(resolveAction({ action: 'nope' }, '[blockout engine v0.2.0-mvp · shots]'), 'shots')
  assert.equal(resolveAction({}, '普通文本'), '')
})

test('issueMessages：code/message 拼装、截断与数量上限', () => {
  assert.deepEqual(issueMessages([{ code: 'scene/version', message: '只接受 version:2' }]), [
    'scene/version: 只接受 version:2',
  ])
  assert.deepEqual(issueMessages(['一条字符串']), ['一条字符串'])
  const long = 'x'.repeat(300)
  const [truncated] = issueMessages([long])
  assert.equal(truncated.length, 221)
  assert.match(truncated, /…$/)
  assert.equal(issueMessages([1, 2, 3, 4, 5], 3).length, 3)
  assert.deepEqual(issueMessages(undefined), [])
})

test('formatNumber / formatRange：非法值回退 —', () => {
  assert.equal(formatNumber(1.23456, 2), '1.23')
  assert.equal(formatNumber(undefined), '—')
  assert.equal(formatRange([0.4, 0.66], 2), '0.4–0.66')
  assert.equal(formatRange(null), '—')
})