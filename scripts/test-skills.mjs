// B5 技能安装单测入口：esbuild 打包 src/services/skills.ts 后跑 node:test。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(pkgRoot, 'lib', '.skills-install.test.mjs')

await mkdir(join(pkgRoot, 'lib'), { recursive: true })
await build({
  entryPoints: [join(pkgRoot, 'src/services/skills.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundle,
  logLevel: 'error',
})

const result = spawnSync(process.execPath, ['--test', 'test/skills-install.test.mjs'], {
  cwd: pkgRoot,
  stdio: 'inherit',
})
await rm(bundle, { force: true })
process.exit(result.status ?? 1)