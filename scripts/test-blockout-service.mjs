// B2 服务单测入口：先用 esbuild 把 src/services/blockout.ts 打成可被 node:test 导入的 ESM，
// 再跑 test/blockout-service.test.mjs。bundle 放在 lib/ 下，使默认引擎定位解析到 lib/blockout/。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(pkgRoot, 'lib', '.blockout-service.test.mjs')

await mkdir(join(pkgRoot, 'lib'), { recursive: true })
await build({
  entryPoints: [join(pkgRoot, 'src/services/blockout.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundle,
  external: ['ffmpeg-static'],
  logLevel: 'error',
})

const result = spawnSync(process.execPath, ['--test', 'test/blockout-service.test.mjs'], {
  cwd: pkgRoot,
  stdio: 'inherit',
})
await rm(bundle, { force: true })
process.exit(result.status ?? 1)