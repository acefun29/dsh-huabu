import { test } from 'node:test'
import assert from 'node:assert/strict'

const { apply } = await import('../lib/.index-apply.test.mjs')

test('apply：注册 huabu.project / huabu.assets / huabu.blockout 与全部工具', () => {
  const provided = new Map()
  const tools = []
  const logs = []
  const ctx = {
    provide(name, value) {
      provided.set(name, value)
    },
    tools: {
      register(def) {
        tools.push(def)
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
  assert.ok(provided.get('huabu.blockout'), 'huabu.blockout 未注册')
  assert.deepEqual(
    tools.map((item) => item.name).sort(),
    [
      'huabu_asset_import',
      'huabu_asset_list',
      'huabu_asset_tag',
      'huabu_blockout',
      'huabu_context',
      'huabu_probe',
      'huabu_probe_plain',
    ],
  )
  assert.match(logs.join('\n'), /huabu\.project 0\.1\.0/)
  assert.match(logs.join('\n'), /huabu\.assets 0\.1\.0/)
})