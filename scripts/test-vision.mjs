// F 阶段单测入口：esbuild 打包 services/vision + tools/vision 后跑 node:test。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundles = [
  ['src/services/vision.ts', '.vision-service.test.mjs'],
  ['src/tools/vision.ts', '.vision-tool.test.mjs'],
  ['src/services/project.ts', '.project-service.test.mjs'],
  ['src/index.ts', '.index-apply.test.mjs'],
]

await mkdir(join(pkgRoot, 'lib'), { recursive: true })
for (const [entry, out] of bundles) {
  await build({
    entryPoints: [join(pkgRoot, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: join(pkgRoot, 'lib', out),
    external: ['ffmpeg-static'],
    logLevel: 'error',
  })
}

const result = spawnSync(
  process.execPath,
  ['--test', 'test/vision.test.mjs', 'test/index-apply.test.mjs'],
  { cwd: pkgRoot, stdio: 'inherit' },
)
for (const [, out] of bundles) await rm(join(pkgRoot, 'lib', out), { force: true })
process.exit(result.status ?? 1)