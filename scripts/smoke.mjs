#!/usr/bin/env node
// 兼容冒烟（DoD #3 / 设计 §8.4）：每次 DSH 升级必跑。
//   1. engines.dsh 与本机 dsh 版本的 semver 兼容（dsh 不可用时跳过并告警）；
//   2. lib/index.js 可 import 且导出 apply（假 ctx 冒烟）；
//   3. lib/client.js 含 __ModuleLoader__.load 且 dsh.client.external 与代码 require 一致；
//   4. cordis.patch.yml 的 insert 行可解析（手写 YAML 子集：缩进 + key: value）；
//   5. 技能源目录可安装（installSkillBundle 到临时 DSH_HOME，逐包校验文件齐全）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

/* 1. engines.dsh 兼容 */
const dshBin = process.env.DSH_BIN ?? 'dsh'
const versionRun = spawnSync(dshBin, ['--version'], { windowsHide: true, timeout: 15000, shell: process.platform === 'win32' })
if (versionRun.status === 0) {
  const current = (versionRun.stdout ?? '').toString().trim().split('\n')[0]
  const range = pkg.engines.dsh
  const [lo, hi] = range.split(/\s*<\s*/)
  const ge = (v, floor) => v >= floor
  const num = (v) => v.split('-')[0].split('.').map(Number)
  const [a1, b1, c1] = num(current)
  const [a2, b2, c2] = num(lo.replace('>=', ''))
  const [a3, b3, c3] = num(hi)
  const aboveFloor = ge([a1, b1, c1], [a2, b2, c2])
  const belowCeil = [a1, b1, c1] < [a3, b3, c3] || (current.includes('-') && [a1, b1, c1] <= [a3, b3, c3])
  check('engines.dsh 兼容', aboveFloor && belowCeil, `dsh ${current} ⊂ ${range}`)
} else {
  console.log('[WARN] dsh --version 不可用（DSH_BIN 可指定），跳过版本校验')
}

/* 2. host bundle 可 import 且 apply 可跑（假 ctx） */
const host = await import(new URL('../lib/index.js', import.meta.url).href)
  .then((m) => m)
  .catch((error) => ({ __error: error }))
if (host.__error) {
  check('lib/index.js 可 import', false, String(host.__error.message ?? host.__error))
} else {
  const provided = []
  const tools = []
  let threw = null
  try {
    host.apply(
      {
        provide: (n, v) => provided.push(n),
        tools: { register: (d) => tools.push(d) },
        systemPrompt: { context() {} },
        logger: { info() {}, warn() {} },
      },
      { installSkills: false },
    )
  } catch (error) {
    threw = error
  }
  check('lib/index.js 导出 apply 且假 ctx 冒烟通过', typeof host.apply === 'function' && threw === null, threw ? threw.message : `provides=${provided.length} tools=${tools.length}`)
}

/* 3. client bundle：模块加载器包装 + external 声明与代码一致 */
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
check('lib/client.js 走 __ModuleLoader__.load', client.includes('__ModuleLoader__.load'))
const externals = pkg.dsh?.client?.external ?? []
for (const ext of externals) {
  check(`dsh.client.external 可解析：${ext}`, new RegExp(`require\\(["']${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\)`).test(client))
}

/* 4. cordis.patch.yml：insert 行解析（子集：- insert: / id|name: value） */
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const insertOk = /-\s*insert:/.test(patch) && /^\s*-?\s*id:\s*\S+/m.test(patch) && /^\s*-?\s*name:\s*\S+/m.test(patch)
check('cordis.patch.yml insert 行可解析', insertOk)

/* 5. 技能源目录可安装（临时 DSH_HOME，两包文件齐全） */
const { installSkillBundle } = await import('../src/services/skills.ts')
const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-huabu-smoke-'))
try {
  // src 直跑时默认源路径不成立（构建态由 lib/../skills 命中），显式指 skills/ 目录
  const results = ['huabu-blockout', 'huabu-media'].map((name) =>
    installSkillBundle({ skillName: name, dshHome: tmpHome, sourceDir: join('skills', name) }),
  )
  check(
    '技能可安装（huabu-blockout + huabu-media）',
    results.every((r) => existsSync(join(r.targetDir, 'SKILL.md'))),
    results.map((r) => r.targetDir.split(/[\/]/).pop()).join(' + '),
  )
} finally {
  rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

console.log(failed === 0 ? '\nsmoke: 全部通过' : `\nsmoke: ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)