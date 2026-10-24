import { test } from 'node:test'
import assert from 'node:assert/strict'

const { apply } = await import('../lib/.index-apply.test.mjs')

test('apply：注册 huabu.project / huabu.assets / huabu.blockout 与全部工具', () => {
  const provided = new Map()
  const tools = []
  const logs = []
  const promptContexts = []
  const ctx = {
    provide(name, value) {
      provided.set(name, value)
    },
    tools: {
      register(def) {
        tools.push(def)
      },
    },
    systemPrompt: {
      context(entry) {
        promptContexts.push(entry)
      },
    },
    logger: {
      info(message) {
        logs.push(message)
      },
      warn(message) {
        logs.push(message)
      },
    },
  }

  apply(ctx, { installSkills: false })

  assert.ok(provided.get('huabu.project'), 'huabu.project 未注册')
  assert.equal(provided.get('huabu.project').version, '0.1.0')
  assert.ok(provided.get('huabu.assets'), 'huabu.assets 未注册')
  assert.equal(provided.get('huabu.assets').version, '0.1.0')
  assert.ok(provided.get('huabu.media'), 'huabu.media 未注册')
  assert.equal(provided.get('huabu.media').version, '0.1.0')
  assert.ok(provided.get('huabu.blockout'), 'huabu.blockout 未注册')
  assert.deepEqual(
    tools.map((item) => item.name).sort(),
    [
      'huabu_asset_import',
      'huabu_asset_list',
      'huabu_asset_tag',
      'huabu_audio_generate',
      'huabu_blockout',
      'huabu_context',
      'huabu_image_generate',
      'huabu_probe',
      'huabu_probe_plain',
      'huabu_video_frames',
      'huabu_video_generate',
      'huabu_video_skim',
    ],
  )
  assert.ok(provided.get('huabu.vision'), 'huabu.vision 未注册')
  assert.match(logs.join('\n'), /huabu\.project 0\.1\.0/)
  assert.match(logs.join('\n'), /huabu\.assets 0\.1\.0/)
})

test('apply：C4 摘要注入注册（systemPrompt.context，text 同步且未知 agent 返回空串）', () => {
  const promptContexts = []
  const ctx = {
    provide() {},
    tools: { register() {} },
    systemPrompt: {
      context(entry) {
        promptContexts.push(entry)
      },
    },
    logger: {},
  }
  apply(ctx, { installSkills: false })
  const digest = promptContexts.find((entry) => entry.name === 'huabu:project-digest')
  assert.ok(digest, 'huabu:project-digest 未注册')
  assert.equal(typeof digest.order, 'number')
  assert.equal(digest.interpolate, false)
  const value = digest.text({ agent: { id: 'unknown-agent' } })
  assert.equal(typeof value, 'string')
  assert.equal(value, '', '未知 agent 首轮必须同步返回空串')

  const disabled = []
  const offCtx = {
    provide() {},
    tools: { register() {} },
    systemPrompt: {
      context(entry) {
        disabled.push(entry)
      },
    },
    logger: {},
  }
  apply(offCtx, { installSkills: false, injectDigest: false })
  assert.equal(disabled.filter((entry) => entry.name === 'huabu:project-digest').length, 0, 'injectDigest=false 时不注册')
})