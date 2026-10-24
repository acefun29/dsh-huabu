// C1 服务单测入口：esbuild 打包 src/services/project.ts（含 session-cwd / fs-atomic）后跑 node:test。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectBundle = join(pkgRoot, 'lib', '.project-service.test.mjs')
const indexBundle = join(pkgRoot, 'lib', '.index-apply.test.mjs')

await mkdir(join(pkgRoot, 'lib'), { recursive: true })
await build({
  entryPoints: [join(pkgRoot, 'src/services/project.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: projectBundle,
  logLevel: 'error',
})
await build({
  entryPoints: [join(pkgRoot, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: indexBundle,
  logLevel: 'error',
})

const result = spawnSync(
  process.execPath,
  ['--test', 'test/project-service.test.mjs', 'test/index-apply.test.mjs'],
  { cwd: pkgRoot, stdio: 'inherit' },
)
await rm(projectBundle, { force: true })
await rm(indexBundle, { force: true })
process.exit(result.status ?? 1)
