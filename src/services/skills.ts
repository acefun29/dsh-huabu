// 技能安装：把随包的技能目录（huabu-blockout / huabu-media）幂等装到 $DSH_HOME/skills/。
// 版本戳在 SKILL.md frontmatter 的 metadata.huabuVersion；同版本跳过（保留用户改动），
// 版本变化才覆盖整包；同版本缺文件只补缺失文件。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HUABU_SKILL_NAME = 'huabu-blockout'
export const HUABU_MEDIA_SKILL_NAME = 'huabu-media'
export const HUABU_SKILL_VERSION = '0.1.0'

/** 每个技能包的固定文件清单（templates/ 目录仍自动扫描 *.json） */
const SKILL_FILES: Record<string, readonly string[]> = {
  [HUABU_SKILL_NAME]: ['SKILL.md', 'engine-README.md'],
  [HUABU_MEDIA_SKILL_NAME]: ['SKILL.md'],
}
const TEMPLATE_DIR = 'templates'

function defaultSkillSource(skillName: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', skillName)
}

export interface InstallSkillOptions {
  /** 技能名（目录名）；缺省 huabu-blockout（兼容 B5 既有调用） */
  skillName?: string
  dshHome?: string
  sourceDir?: string
  version?: string
  env?: NodeJS.ProcessEnv
  home?: string
}

export interface InstallSkillResult {
  status: 'installed' | 'up-to-date'
  targetDir: string
  version: string
  copied: string[]
}

/** DSH_HOME 优先，其次 ~/.dsh（与 dsh-home-paths 的口径一致） */
export function resolveSkillDshHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.DSH_HOME?.trim()
  if (!configured) return join(home, '.dsh')
  if (configured === '~') return home
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return join(home, configured.slice(2))
  }
  return configured
}

interface FrontmatterMatch {
  start: string
  body: string
  end: string
  rest: string
}

function splitFrontmatter(text: string): FrontmatterMatch | null {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(text)
  if (!match) return null
  return {
    start: match[1],
    body: match[2],
    end: match[3],
    rest: text.slice(match.index + match[0].length),
  }
}

/** 确保 frontmatter 的 metadata.huabuVersion 等于当前插件版本 */
export function withVersionStamp(skillText: string, version: string): string {
  const parts = splitFrontmatter(skillText)
  if (!parts) throw new Error('SKILL.md 缺少 YAML frontmatter')
  let frontmatter = parts.body

  if (/^\s+huabuVersion:\s*.*$/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(/^(\s+)huabuVersion:\s*.*$/m, `$1huabuVersion: ${version}`)
  } else if (/^metadata:\s*$/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(/^metadata:\s*$/m, `metadata:\n  huabuVersion: ${version}`)
  } else {
    frontmatter = `${frontmatter}\nmetadata:\n  huabuVersion: ${version}`
  }

  return `${parts.start}${frontmatter}${parts.end}${parts.rest}`
}

export function readSkillVersion(skillText: string): string | undefined {
  const parts = splitFrontmatter(skillText)
  if (!parts) return undefined
  const match = /^\s+huabuVersion:\s*["']?([^\s"'#]+)["']?\s*$/m.exec(parts.body)
  return match?.[1]
}

interface SkillFile {
  relPath: string
  absPath: string
}

function listSkillFiles(skillName: string, sourceDir: string): SkillFile[] {
  const files: SkillFile[] = (SKILL_FILES[skillName] ?? ['SKILL.md']).map((name) => ({
    relPath: name,
    absPath: join(sourceDir, name),
  }))
  const templatesDir = join(sourceDir, TEMPLATE_DIR)
  if (existsSync(templatesDir)) {
    for (const name of readdirSync(templatesDir).filter((entry) => entry.endsWith('.json')).sort()) {
      files.push({ relPath: `${TEMPLATE_DIR}/${name}`, absPath: join(templatesDir, name) })
    }
  }
  for (const file of files) {
    if (!existsSync(file.absPath)) throw new Error(`技能源文件缺失：${file.absPath}`)
  }
  return files
}

/** tmp+rename，避免进程中断留下半截 SKILL.md（Windows 不允许 rename 覆盖已有文件） */
function writeFileAtomic(target: string, content: string | Buffer): void {
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, content)
  try {
    renameSync(temp, target)
  } catch {
    try {
      unlinkSync(target)
    } catch {
      /* 目标不存在 */
    }
    renameSync(temp, target)
  }
}

export function installSkillBundle(options: InstallSkillOptions = {}): InstallSkillResult {
  const skillName = options.skillName ?? HUABU_SKILL_NAME
  const version = options.version ?? HUABU_SKILL_VERSION
  const dshHome = options.dshHome ?? resolveSkillDshHome(options.env, options.home)
  const sourceDir = options.sourceDir ?? defaultSkillSource(skillName)
  const targetDir = join(dshHome, 'skills', skillName)
  const files = listSkillFiles(skillName, sourceDir)
  const skillSource = readFileSync(join(sourceDir, 'SKILL.md'), 'utf8')
  const stampedSkill = withVersionStamp(skillSource, version)
  const skillTarget = join(targetDir, 'SKILL.md')

  let installedVersion: string | undefined
  if (existsSync(skillTarget)) {
    try {
      installedVersion = readSkillVersion(readFileSync(skillTarget, 'utf8'))
    } catch {
      installedVersion = undefined
    }
  }

  const missing = files.filter((file) => !existsSync(join(targetDir, file.relPath)))
  if (installedVersion === version && missing.length === 0) {
    return { status: 'up-to-date', targetDir, version, copied: [] }
  }

  // 版本不同（或没有版本戳）→ 整包覆盖；同版本 → 只补缺失文件，保留用户改动
  const overwrite = installedVersion !== version
  mkdirSync(targetDir, { recursive: true })
  const copied: string[] = []
  for (const file of files) {
    const target = join(targetDir, file.relPath)
    if (!overwrite && existsSync(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    const content = file.relPath === 'SKILL.md' ? stampedSkill : readFileSync(file.absPath)
    writeFileAtomic(target, content)
    copied.push(file.relPath)
  }
  return { status: 'installed', targetDir, version, copied }
}

/** 装全部技能包（apply 用）：单包失败不影响其余 */
export function installAllSkillBundles(options: InstallSkillOptions = {}): InstallSkillResult[] {
  const out: InstallSkillResult[] = []
  for (const skillName of Object.keys(SKILL_FILES)) {
    out.push(installSkillBundle({ ...options, skillName }))
  }
  return out
}

/** 供测试/诊断：安装后的 SKILL.md 修改时间（毫秒） */
export function skillMtime(targetDir: string): number | undefined {
  try {
    return statSync(join(targetDir, 'SKILL.md')).mtimeMs
  } catch {
    return undefined
  }
}