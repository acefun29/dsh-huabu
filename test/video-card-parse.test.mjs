// E4 MediaJobCard 纯解析单测：确认/运行/同步完成/失败四态。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseMediaJobResult } = await import('../lib/.video-card.test.mjs')

test('parseMediaJobResult：待确认（含 provider 头）', () => {
  const parsed = parseMediaJobResult(
    '[huabu_video_generate · mock/mock/clip] 需要用户确认后才提交（视频生成成本高）。\n拟提交参数：prompt「城市夜景」 · 时长 6s。',
  )
  assert.equal(parsed.state, 'confirm')
  assert.equal(parsed.provider, 'mock')
  assert.equal(parsed.model, 'mock/clip')
})

test('parseMediaJobResult：后台运行（提取 jobId）', () => {
  const parsed = parseMediaJobResult(
    '[huabu_video_generate · mock/mock/clip] 已提交后台任务（job huabu-videoab12cd34），会话不被阻塞。',
  )
  assert.equal(parsed.state, 'running')
  assert.equal(parsed.jobId, 'huabu-videoab12cd34')
})

test('parseMediaJobResult：同步完成（提取路径）', () => {
  const parsed = parseMediaJobResult(
    '[huabu_video_generate · mock/mock/clip]（同步模式：宿主无 jobs 服务）\n完成：assets/video/e2-sync.mp4',
  )
  assert.equal(parsed.state, 'done')
  assert.equal(parsed.artifactRelPath, 'assets/video/e2-sync.mp4')
  assert.equal(parsed.sync, true)
})

test('parseMediaJobResult：失败/未知文本不抛', () => {
  assert.equal(parseMediaJobResult('生成失败：provider mock 缺少凭据').state, 'error')
  assert.equal(parseMediaJobResult('随便').state, 'unknown')
})
