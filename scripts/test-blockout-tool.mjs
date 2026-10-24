// B3 工具单测入口：esbuild 打包服务与工具两个模块，再跑 test/blockout-tool.test.mjs。
// bundle 放 lib/ 下，使默认引擎定位解析到 lib/blockout/（需先 pnpm build）。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(pkgRoot, 'lib')

if (!existsSync(join(libDir, 'blockout', 'cli.mjs'))) {
  console.error('lib/blockout/cli.mjs 不存在：先运行 pnpm build')
  process.exit(1)
}

const bundles = [
  { entry: join(pkgRoot, 'src/services/blockout.ts'), outfile: join(libDir, '.blockout-service.test.mjs') },
  { entry: join(pkgRoot, 'src/tools/blockout.ts'), outfile: join(libDir, '.blockout-tool.test.mjs') },
]

await mkdir(libDir, { recursive: true })
for (const bundle of bundles) {
  await build({
    entryPoints: [bundle.entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundle.outfile,
    external: ['ffmpeg-static'],
    logLevel: 'error',
  })
}

const result = spawnSync(process.execPath, ['--test', 'test/blockout-tool.test.mjs'], {
  cwd: pkgRoot,
  stdio: 'inherit',
})
await Promise.all(bundles.map((bundle) => rm(bundle.outfile, { force: true })))
process.exit(result.status ?? 1)
