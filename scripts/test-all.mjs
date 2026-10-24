// G4：一条命令全绿门禁——typecheck → build（含主题/体积守卫）→ 引擎自检（src+lib）→ 漂移 → 全部单测。
// CI（.github/workflows/ci.yml）与本地共用本入口。
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const steps = [
  ['typecheck', ['pnpm', ['typecheck']]],
  ['build', ['pnpm', ['build']]],
  ['blockout selftest (src)', ['node', ['src/blockout/selftest.mjs']]],
  ['blockout selftest (lib)', ['node', ['lib/blockout/selftest.mjs']]],
  ['drift check', ['pnpm', ['check:drift']]],
  ['service tests', ['pnpm', ['test:service']]],
  ['tool tests', ['pnpm', ['test:tool']]],
  ['skills tests', ['pnpm', ['test:skills']]],
  ['card tests', ['pnpm', ['test:card']]],
  ['project tests', ['pnpm', ['test:project']]],
  ['assets tests', ['pnpm', ['test:assets']]],
  ['asset-tools tests', ['pnpm', ['test:asset-tools']]],
  ['media tests', ['pnpm', ['test:media']]],
  ['image tests', ['pnpm', ['test:image']]],
  ['video tests', ['pnpm', ['test:video']]],
  ['vision tests', ['pnpm', ['test:vision']]],
]

let failed = 0
for (const [name, [cmd, args]] of steps) {
  const run = spawnSync(cmd, args, { cwd: pkgRoot, stdio: 'inherit', shell: process.platform === 'win32' })
  const ok = run.status === 0
  if (!ok) failed += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
}

// 体积守卫（DoD #4：client < 500KB）
const clientBundle = join(pkgRoot, 'lib', 'client.js')
if (existsSync(clientBundle)) {
  const kb = statSync(clientBundle).size / 1024
  const ok = kb < 500
  if (!ok) failed += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] client bundle size: ${kb.toFixed(1)}KB (budget 500KB)`)
} else {
  failed += 1
  console.log('[FAIL] client bundle missing')
}

process.exit(failed > 0 ? 1 : 0)