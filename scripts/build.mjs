// dsh-huabu 完整构建流水线（A2）：
//   1) host：src/index.ts → lib/index.js（esm/node，@deepseek-ai/* 与 ffmpeg-static 外置）
//   2) client：src/client/index.tsx → lib/client.js（cjs/browser，包 window.__ModuleLoader__.load 包装）
//   3) blockout：本仓 src/blockout 原样拷贝 → lib/blockout/（零依赖引擎 + selftest 随包分发；
//      src/blockout 由主仓库 ../src/main/blockout 入库，漂移校验见 scripts/check-drift.mjs）
//   4) electron 守卫：扫描 lib/ 内对 electron 的真实模块引用（import/require），命中即构建失败；
//      注释/文案里的 "Electron" 字样只告警（render.mjs 有一处文档注释）。
//   5) theme 守卫：src/client/theme.css 的 --huabu-* 变量只允许布局尺寸，出现颜色值即失败。
// 主仓库（../src）只读参考，本脚本不写入主仓库任何文件。
import { build } from 'esbuild'
import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(pkgRoot, 'lib')
const blockoutSrc = join(pkgRoot, 'src/blockout')

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

/* ── 1. host ─────────────────────────────────────────────── */
async function buildHost() {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: 'lib/index.js',
    external: ['@deepseek-ai/*', 'ffmpeg-static'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    logLevel: 'info',
  })
}

/* ── 2. client ───────────────────────────────────────────── */
const CLIENT_BANNER = `window.__ModuleLoader__.load({ id: "dsh-huabu", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const CLIENT_FOOTER = `
return module.exports;
}});
`

async function buildClient() {
  // baseline 模块（react 等）不打包：由平台静态模块表经 factory 的 require 提供
  await build({
    entryPoints: ['src/client/index.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    outfile: 'lib/.client.body.js',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom'],
    loader: { '.css': 'text' },
    logLevel: 'info',
  })
  const body = await readFile('lib/.client.body.js', 'utf8')
  await rm('lib/.client.body.js')
  await writeFile('lib/client.js', CLIENT_BANNER + body + CLIENT_FOOTER, 'utf8')
}

/* ── 3. blockout 引擎拷贝 ────────────────────────────────── */
async function copyBlockout() {
  const srcStat = await stat(blockoutSrc).catch(() => null)
  if (!srcStat?.isDirectory()) {
    throw new Error(`blockout 引擎源不存在：${blockoutSrc}`)
  }
  await cp(blockoutSrc, join(libDir, 'blockout'), { recursive: true })
}

/* ── 4. electron 守卫 ────────────────────────────────────── */
// 只认真实模块引用：import/require/dynamic import 的说明符以 electron（含子路径）开头
const ELECTRON_IMPORT_RE =
  /(?:from\s*["']electron(?:\/[^"']*)?["']|require\s*\(\s*["']electron(?:\/[^"']*)?["']\s*\)|import\s*\(\s*["']electron(?:\/[^"']*)?["']\s*\)|import\s*["']electron(?:\/[^"']*)?["'])/g
const ELECTRON_WORD_RE = /electron/i

async function guardElectron() {
  const errors = []
  const warnings = []
  for (const file of await walk(libDir)) {
    if (!/\.(js|mjs|cjs)$/.test(file)) continue
    const rel = relative(pkgRoot, file)
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      ELECTRON_IMPORT_RE.lastIndex = 0
      if (ELECTRON_IMPORT_RE.test(line)) {
        errors.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
      } else if (ELECTRON_WORD_RE.test(line)) {
        warnings.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
      }
    })
  }
  for (const w of warnings) console.warn(`[guard] electron 字样（非模块引用，仅告警）: ${w}`)
  if (errors.length) {
    for (const e of errors) console.error(`[guard] electron 模块引用: ${e}`)
    throw new Error(`electron 守卫命中 ${errors.length} 处真实引用，构建失败`)
  }
}

/* ── 5. theme 变量守卫 ───────────────────────────────────── */
const COLOR_VALUE_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|var\(\s*--dsw-/i

async function guardThemeVars() {
  const css = await readFile('src/client/theme.css', 'utf8')
  const decls = [...css.matchAll(/(--huabu-[a-z0-9-]+)\s*:\s*([^;]+);/gi)]
  const bad = decls.filter((m) => COLOR_VALUE_RE.test(m[2]))
  if (bad.length) {
    for (const m of bad) console.error(`[theme] ${m[1]}: ${m[2].trim()}`)
    throw new Error(`--huabu-* 只能放布局尺寸，检测到 ${bad.length} 个颜色值`)
  }
  console.log(`[theme] --huabu-* 布局变量 ${decls.length} 个，未发现颜色值`)
}

/* ── main ────────────────────────────────────────────────── */
await rm(libDir, { recursive: true, force: true })
await buildHost()
await buildClient()
await copyBlockout()
await guardThemeVars()
await guardElectron()

const produced = (await walk(libDir)).map((f) => relative(pkgRoot, f)).sort()
console.log(`\n[dsh-huabu] 构建完成，lib/ 共 ${produced.length} 个文件：`)
for (const f of produced) console.log(`  ${f}`)