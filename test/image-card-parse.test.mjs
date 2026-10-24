// D3 ImageCard 纯解析单测：头/路径/尺寸/比例/大小与截断回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseImageResult, imageArgSummary } = await import('../lib/.image-parse.test.mjs')

test('parseImageResult：完整结果行各字段独立解析（懒惰匹配截断回归）', () => {
  const parsed = parseImageResult(
    '[huabu_image_generate · mock/mock/poster]\n生成完成：assets/images/d3-vertical.png，实际 720×1280px（比例 9:16），大小 6KB。\n产物已同时归档进素材库。',
  )
  assert.equal(parsed.provider, 'mock')
  assert.equal(parsed.model, 'mock/poster')
  assert.equal(parsed.artifactRelPath, 'assets/images/d3-vertical.png')
  assert.equal(parsed.dimensions, '720×1280')
  assert.equal(parsed.ratio, '9:16')
  assert.equal(parsed.sizeKb, '6')
})

test('parseImageResult：字段缺失时缺省（无比例/无大小）', () => {
  const parsed = parseImageResult('[huabu_image_generate · dashscope/wan2.7-image]\n生成完成：assets/images/a.png，实际 1024×1024px。')
  assert.equal(parsed.artifactRelPath, 'assets/images/a.png')
  assert.equal(parsed.dimensions, '1024×1024')
  assert.equal(parsed.ratio, undefined)
  assert.equal(parsed.sizeKb, undefined)
})

test('parseImageResult：非本工具文本 → 全缺省不抛', () => {
  const parsed = parseImageResult('随便一段话')
  assert.equal(parsed.provider, undefined)
  assert.equal(parsed.artifactRelPath, undefined)
})

test('imageArgSummary：比例/命名/垫图张数', () => {
  assert.deepEqual(imageArgSummary({ ratio: '16:9', name: 'hero', reference_images: ['a.png', 'b.png'] }), [
    ['比例', '16:9'],
    ['命名', 'hero'],
    ['垫图', '2 张'],
  ])
  assert.deepEqual(imageArgSummary({}), [])
})
