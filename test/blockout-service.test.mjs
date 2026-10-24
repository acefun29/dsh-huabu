import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const { BlockoutService, resolveEngineCli, resolveSessionCwd, runEngineCli } = await import(
  '../lib/.blockout-service.test.mjs'
)

const MINI_SCENE = {
  version: 2,
  drivers: { H: 1, W: 1, D: 1 },
  defs: {
    table: {
      parts: [
        {
          id: 'top',
          shape: 'box',
          size: [4, 4, '$D*0.1'],
          at: { anchor: 'base_center', to: 'ground', offset: [0, 0, '$H'] },
        },
      ],
    },
    thing: {
      parts: [{ id: 'cube', shape: 'box', size: ['$W', '$W', '$W'], at: { rest: 'ground' } }],
    },
  },
  scene: [
    { use: 'table', id: 'table', at: {} },
    { use: 'thing', id: 'thing', at: { to: { ref: 'table/top', anchor: 'face(+Z)' }, offset: [0, 0, 0] } },
  ],
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-huabu-b2-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

async function writeScene(dir) {
  const scene = join(dir, 'mini.author.json')
  await writeFile(scene, JSON.stringify(MINI_SCENE), 'utf8')
  return scene
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function waitForPidFile(file) {
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      const text = await readFile(file, 'utf8')
      const pid = Number(text.trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {
      /* 还没写 */
    }
    if (Date.now() > deadline) throw new Error(`等待 PID 文件超时：${file}`)
    await delay(25)
  }
}

async function waitForDead(pid) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return
    await delay(50)
  }
  assert.fail(`子进程树未清理干净，PID ${pid} 仍存活`)
}

/** 假引擎：拉起一个孙进程并记录双方 PID，然后挂起，用于超时/取消的子进程树测试 */
async function writeHangingEngine(dir) {
  await writeFile(
    join(dir, 'cli.mjs'),
    `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const [parentFile, childFile] = process.argv.slice(2)
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(parentFile, String(process.pid))
writeFileSync(childFile, String(child.pid))
setInterval(() => {}, 1000)
`,
    'utf8',
  )
}

test('resolveEngineCli 默认定位到构建产物 lib/blockout/cli.mjs', () => {
  const cli = resolveEngineCli()
  assert.ok(cli, '未找到引擎 CLI')
  assert.match(cli.replace(/\\/g, '/'), /\/lib\/blockout\/cli\.mjs$/)
})

test('引擎缺失时返回可读的 spawnError，不抛异常', async () => {
  await withTempDir(async (dir) => {
    const run = await runEngineCli(['describe', '--scene', 'x.json'], {
      cwd: dir,
      engineDir: join(dir, 'missing'),
    })
    assert.equal(run.code, -1)
    assert.match(run.spawnError, /引擎文件缺失/)
    assert.equal(run.durationMs >= 0, true)
  })
})

test('describe：给定 scene 产出可解析 JSON（stdout 收集）', async () => {
  await withTempDir(async (dir) => {
    const scene = await writeScene(dir)
    const run = await runEngineCli(['describe', '--scene', scene], { cwd: dir, timeoutMs: 30_000 })
    assert.equal(run.code, 0, run.stderr)
    assert.equal(run.timedOut, false)
    assert.equal(run.aborted, false)
    const parsed = JSON.parse(run.stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.partCount, 2)
    assert.deepEqual(parsed.instances, ['table', 'thing'])
  })
})

test('sheet：给定 scene 产出 PNG 文件', async () => {
  await withTempDir(async (dir) => {
    const scene = await writeScene(dir)
    const out = join(dir, 'sheet.png')
    const run = await runEngineCli(['sheet', '--scene', scene, '--out', out, '--size', '512'], {
      cwd: dir,
      timeoutMs: 30_000,
    })
    assert.equal(run.code, 0, run.stderr)
    const parsed = JSON.parse(run.stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.image, out)
    assert.ok(parsed.bytes > 1000, `PNG 过小：${parsed.bytes}`)
    const bytes = await readFile(out)
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '不是 PNG 魔数')
  })
})

test('进度行解析：渲染 i/N 进入 progress 并回调', async () => {
  await withTempDir(async (dir) => {
    const engineDir = join(dir, 'engine')
    await mkdir(engineDir, { recursive: true })
    await writeFile(
      join(engineDir, 'cli.mjs'),
      `process.stderr.write('  渲染 3/10\\n')
process.stderr.write('  渲染 7/10\\n')
process.stdout.write(JSON.stringify({ ok: true, fake: true }) + '\\n')
`,
      'utf8',
    )
    const seen = []
    const run = await runEngineCli(['video'], {
      cwd: dir,
      engineDir,
      timeoutMs: 10_000,
      onProgress: (event) => seen.push(event),
    })
    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(run.progress, [
      { done: 3, total: 10 },
      { done: 7, total: 10 },
    ])
    assert.deepEqual(seen, run.progress)
    assert.equal(JSON.parse(run.stdout).fake, true)
  })
})

test('超时：杀掉整棵子进程树（父 + 孙）', async () => {
  await withTempDir(async (dir) => {
    const engineDir = join(dir, 'engine')
    await mkdir(engineDir, { recursive: true })
    await writeHangingEngine(engineDir)
    const parentFile = join(dir, 'parent.pid')
    const childFile = join(dir, 'child.pid')

    const runPromise = runEngineCli([parentFile, childFile], {
      cwd: dir,
      engineDir,
      timeoutMs: 1500,
    })
    const parentPid = await waitForPidFile(parentFile)
    const childPid = await waitForPidFile(childFile)
    const run = await runPromise

    assert.equal(run.timedOut, true)
    assert.equal(run.aborted, false)
    await waitForDead(parentPid)
    await waitForDead(childPid)
  })
})

test('取消：AbortSignal 中断后子进程树无残留，且及时结算', async () => {
  await withTempDir(async (dir) => {
    const engineDir = join(dir, 'engine')
    await mkdir(engineDir, { recursive: true })
    await writeHangingEngine(engineDir)
    const parentFile = join(dir, 'parent.pid')
    const childFile = join(dir, 'child.pid')
    const controller = new AbortController()

    const startedAt = Date.now()
    const runPromise = runEngineCli([parentFile, childFile], {
      cwd: dir,
      engineDir,
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    const parentPid = await waitForPidFile(parentFile)
    const childPid = await waitForPidFile(childFile)
    controller.abort()
    const run = await runPromise

    assert.equal(run.aborted, true)
    assert.equal(run.timedOut, false)
    assert.ok(Date.now() - startedAt < 6000, '取消后应在兜底时间内结算')
    await waitForDead(parentPid)
    await waitForDead(childPid)
  })
})

test('resolveSessionCwd 走 exec.agent + workingDirectory.ensure（不读 exec.cwd）', async () => {
  const agent = { id: 'agent-1' }
  const controller = new AbortController()
  const calls = []
  const ctx = {
    workingDirectory: {
      async ensure(receivedAgent, signal) {
        calls.push({ receivedAgent, signal })
        return 'C:/real/session-workspace'
      },
    },
  }
  const cwd = await resolveSessionCwd(ctx, {
    agent,
    signal: controller.signal,
    cwd: 'C:/host/process/cwd',
  })
  assert.equal(cwd, 'C:/real/session-workspace')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].receivedAgent, agent)
  assert.equal(calls[0].signal, controller.signal)
})

test('resolveSessionCwd 缺 agent / 服务时给出可操作错误', async () => {
  await assert.rejects(
    () => resolveSessionCwd({ workingDirectory: { ensure: async () => 'x' } }, {}),
    /没有 agent 会话/,
  )
  await assert.rejects(() => resolveSessionCwd({}, { agent: {} }), /workingDirectory 服务不可用/)
})

test('BlockoutService 暴露版本与动作超时', () => {
  const service = new BlockoutService()
  assert.equal(service.version, '0.2.0-mvp')
  assert.equal(service.timeoutFor('sheet'), 60_000)
  assert.equal(service.timeoutFor('video'), 300_000)
  assert.equal(service.resolveCli(), resolveEngineCli())
})