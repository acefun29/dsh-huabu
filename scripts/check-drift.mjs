// 双形态漂移控制（设计 §6.9）：src/blockout 为入库副本，
// 清单同时记录「入库时副本哈希」与「上游哈希」，任一变化都报警。
//   node scripts/check-drift.mjs          # 校验，漂移 exit 1
//   node scripts/check-drift.mjs --write  # 重新入库后刷新清单
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(pkgRoot, 'scripts/drift-manifest.json')
const write = process.argv.includes('--write')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isTracked(name) {
  return name.endsWith('.mjs') || name === 'README.md'
}

async function snapshot(dir) {
  const out = {}
  for (const name of (await readdir(dir)).sort()) {
    if (!isTracked(name)) continue
    out[name] = sha256(await readFile(join(dir, name)))
  }
  return out
}

function diffSets(label, actual, expected) {
  const problems = []
  for (const [name, hash] of Object.entries(expected)) {
    if (!(name in actual)) problems.push(`${label}: 缺少 ${name}`)
    else if (actual[name] !== hash) problems.push(`${label}: ${name} 内容已变`)
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected)) problems.push(`${label}: 多出 ${name}`)
  }
  return problems
}

const blockout = JSON.parse(await readFile(manifestPath, 'utf8')).blockout
const vendoredDir = resolve(pkgRoot, blockout.vendored)
const upstreamDir = resolve(pkgRoot, blockout.upstream)

const vendored = await snapshot(vendoredDir)

if (write) {
  const upstreamStat = await stat(upstreamDir).catch(() => null)
  if (!upstreamStat?.isDirectory()) {
    throw new Error(`上游目录不存在，无法写入清单：${upstreamDir}`)
  }
  let upstreamCommit = blockout.upstreamCommit
  try {
    upstreamCommit = execFileSync(
      'git',
      ['-C', resolve(pkgRoot, '..'), 'log', '-1', '--format=%h', '--', 'src/main/blockout'],
      { encoding: 'utf8' },
    ).trim()
  } catch {
    /* 无 git 环境时保留旧提交号 */
  }
  const next = {
    blockout: {
      vendored: blockout.vendored,
      upstream: blockout.upstream,
      upstreamCommit,
      vendoredAt: new Date().toISOString().slice(0, 10),
      vendoredFiles: vendored,
      upstreamFiles: await snapshot(upstreamDir),
    },
  }
  await writeFile(manifestPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
  console.log(`[drift] 已刷新 ${Object.keys(vendored).length} 个文件的哈希（上游 ${upstreamCommit || 'unknown'}）`)
  process.exit(0)
}

const problems = diffSets('src/blockout', vendored, blockout.vendoredFiles)
const upstreamStat = await stat(upstreamDir).catch(() => null)
if (upstreamStat?.isDirectory()) {
  const upstream = await snapshot(upstreamDir)
  const upstreamProblems = diffSets('上游', upstream, blockout.upstreamFiles)
  problems.push(...upstreamProblems)
  console.log(
    `[drift] 上游 ${blockout.upstream}（@${blockout.upstreamCommit || 'unknown'}）：` +
      (upstreamProblems.length ? '有漂移' : '一致'),
  )
} else {
  console.warn(`[drift] 上游目录不存在，跳过上游比对：${upstreamDir}`)
}

if (problems.length) {
  for (const p of problems) console.error(`[drift] ${p}`)
  console.error(`[drift] 检测到 ${problems.length} 处漂移：更新上游或重新入库后执行 node scripts/check-drift.mjs --write`)
  process.exit(1)
}
console.log(`[drift] src/blockout 与清单一致（${Object.keys(vendored).length} 个文件，入库于 ${blockout.vendoredAt}）`)