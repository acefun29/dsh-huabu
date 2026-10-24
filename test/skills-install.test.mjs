import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  HUABU_SKILL_NAME,
  HUABU_SKILL_VERSION,
  installSkillBundle,
  readSkillVersion,
  resolveSkillDshHome,
  withVersionStamp,
} = await import('../lib/.skills-install.test.mjs')

const sourceDir = join(process.cwd(), 'skills', HUABU_SKILL_NAME)
const sourceSkill = await readFile(join(sourceDir, 'SKILL.md'), 'utf8')

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-huabu-b5-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

test('技能名与版本：source frontmatter 与 package.json 一致', async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(HUABU_SKILL_VERSION, pkg.version)
  assert.equal(readSkillVersion(sourceSkill), HUABU_SKILL_VERSION)
  assert.match(sourceSkill, /^name: huabu-blockout$/m)
  assert.match(sourceSkill, /^ {2}huabuVersion: 0\.1\.0$/m)
})

test('withVersionStamp：替换已有版本 / 补 metadata / 无 frontmatter 报错', () => {
  const replaced = withVersionStamp(sourceSkill, '9.9.9')
  assert.equal(readSkillVersion(replaced), '9.9.9')

  const noMetadata = `---\nname: demo\ndescription: demo skill\n---\n\n# Demo\n`
  const stamped = withVersionStamp(noMetadata, '1.2.3')
  assert.equal(readSkillVersion(stamped), '1.2.3')
  assert.match(stamped, /metadata:\n {2}huabuVersion: 1\.2\.3/)

  assert.throws(() => withVersionStamp('# no frontmatter\n', '1.0.0'), /frontmatter/)
})

test('resolveSkillDshHome：DSH_HOME 优先、空值回退 ~/.dsh、支持 ~ 展开', () => {
  assert.equal(resolveSkillDshHome({ DSH_HOME: 'D:\\custom\\dsh' }, 'C:\\Users\\demo'), 'D:\\custom\\dsh')
  assert.equal(resolveSkillDshHome({ DSH_HOME: '   ' }, 'C:\\Users\\demo'), join('C:\\Users\\demo', '.dsh'))
  assert.equal(resolveSkillDshHome({ DSH_HOME: '~/elsewhere' }, 'C:\\Users\\demo'), join('C:\\Users\\demo', 'elsewhere'))
})

test('首次安装：SKILL.md（带版本戳）+ engine-README + 模板全部落到 $DSH_HOME/skills', async () => {
  await withTempDir(async (dir) => {
    const result = installSkillBundle({ dshHome: dir, version: HUABU_SKILL_VERSION })
    assert.equal(result.status, 'installed')
    assert.equal(result.targetDir, join(dir, 'skills', HUABU_SKILL_NAME))
    assert.equal(readSkillVersion(await readFile(join(result.targetDir, 'SKILL.md'), 'utf8')), HUABU_SKILL_VERSION)
    assert.equal(existsSync(join(result.targetDir, 'engine-README.md')), true)
    assert.equal(existsSync(join(result.targetDir, 'templates', 'perfume-on-table.author.json')), true)
    assert.equal(existsSync(join(result.targetDir, 'templates', 'car-on-road.author.json')), true)
    assert.deepEqual(result.copied.sort(), [
      'SKILL.md',
      'engine-README.md',
      'templates/car-on-road.author.json',
      'templates/perfume-on-table.author.json',
    ])
  })
})

test('重复安装：同版本不重写（mtime 不变）；用户改动保留', async () => {
  await withTempDir(async (dir) => {
    const first = installSkillBundle({ dshHome: dir, version: HUABU_SKILL_VERSION })
    const skillPath = join(first.targetDir, 'SKILL.md')
    const past = new Date(Date.now() - 60_000)
    await utimes(skillPath, past, past)
    const beforeMtime = statSync(skillPath).mtimeMs

    const second = installSkillBundle({ dshHome: dir, version: HUABU_SKILL_VERSION })
    assert.equal(second.status, 'up-to-date')
    assert.deepEqual(second.copied, [])
    assert.equal(statSync(skillPath).mtimeMs, beforeMtime, '同版本不应重写 SKILL.md')

    const original = await readFile(skillPath, 'utf8')
    await writeFile(skillPath, `${original}\n<!-- 用户手改 -->\n`, 'utf8')
    const third = installSkillBundle({ dshHome: dir, version: HUABU_SKILL_VERSION })
    assert.equal(third.status, 'up-to-date')
    assert.match(await readFile(skillPath, 'utf8'), /用户手改/)
  })
})

test('同版本缺文件：只补缺失文件，不重写 SKILL.md', async () => {
  await withTempDir(async (dir) => {
    const first = installSkillBundle({ dshHome: dir, version: HUABU_SKILL_VERSION })
    const skillPath = join(first.targetDir, 'SKILL.md')
    const template = join(first.targetDir, 'templates', 'perfume-on-table.author.json')
    const past = new Date(Date.now() - 60_000)
    await utimes(skillPath, past, past)
    const beforeMtime = statSync(skillPath).mtimeMs
    await unlink(template)

    const repaired = installSkillBundle({ dshHome: dir, version: HUABU_SKILL_VERSION })
    assert.equal(repaired.status, 'installed')
    assert.deepEqual(repaired.copied, ['templates/perfume-on-table.author.json'])
    assert.equal(existsSync(template), true)
    assert.equal(statSync(skillPath).mtimeMs, beforeMtime)
  })
})

test('版本变化：整包覆盖，SKILL.md 版本戳更新', async () => {
  await withTempDir(async (dir) => {
    installSkillBundle({ dshHome: dir, version: HUABU_SKILL_VERSION })
    const upgraded = installSkillBundle({ dshHome: dir, version: '9.9.9' })
    assert.equal(upgraded.status, 'installed')
    assert.equal(readSkillVersion(await readFile(join(upgraded.targetDir, 'SKILL.md'), 'utf8')), '9.9.9')
    assert.equal(upgraded.copied.includes('SKILL.md'), true)
    assert.equal(upgraded.copied.includes('engine-README.md'), true)
  })
})

test('源文件缺失：安装前抛可读错误', async () => {
  await withTempDir(async (dir) => {
    const emptySource = join(dir, 'empty-skill')
    await mkdir(emptySource, { recursive: true })
    assert.throws(
      () => installSkillBundle({ dshHome: join(dir, 'home'), sourceDir: emptySource }),
      /技能源文件缺失/,
    )
  })
})
