// huabu_video_generate / huabu_audio_generate 的工具卡。
// 工具本身秒回（确认闸门文本或后台 jobId），卡片按结果文本分支四态：
// 待确认 / 后台运行中（jobId + job_output 提示）/ 同步完成（路径）/ 失败。
import * as React from 'react'

type Any = Record<string, any>
type Phase = 'preparing' | 'start' | 'result'
type Tone = 'ok' | 'warn' | 'error' | 'busy' | 'muted'

function phaseOf(props: Any): Phase {
  return props.phase === 'preparing' ? 'preparing' : props.phase === 'start' ? 'start' : 'result'
}

/** 结果文本 → 卡片状态（纯函数，单测在 video-card-parse） */
export function parseMediaJobResult(text: string): {
  state: 'confirm' | 'running' | 'done' | 'error' | 'unknown'
  jobId?: string
  provider?: string
  model?: string
  artifactRelPath?: string
  sync?: boolean
} {
  const header = /^\[huabu_(video|audio)_generate · ([^/\]]+)\/([^\]]+)\]/.exec(text.split('\n')[0] ?? '')
  const confirm = /需要用户确认/.test(text)
  const submitted = /已提交后台任务（job ([^）]+)）/.exec(text)
  const syncDone = /（同步模式：宿主无 jobs 服务）[\s\S]*完成：(\S+)/.exec(text)
  const failed = /生成失败：(.+)/.exec(text)
  return {
    state: confirm ? 'confirm' : submitted ? 'running' : syncDone ? 'done' : failed ? 'error' : 'unknown',
    ...(submitted ? { jobId: submitted[1] } : {}),
    ...(header ? { provider: header[2], model: header[3] } : {}),
    ...(syncDone ? { artifactRelPath: syncDone[1], sync: true } : {}),
  }
}

function statusOf(phase: Phase, block: Any, parsed: ReturnType<typeof parseMediaJobResult>): { label: string; tone: Tone } {
  if (phase === 'preparing') return { label: '准备参数', tone: 'muted' }
  if (phase === 'start') return { label: '提交中', tone: 'busy' }
  if (block?.isError) return { label: '失败', tone: 'error' }
  if (parsed.state === 'confirm') return { label: '待确认', tone: 'warn' }
  if (parsed.state === 'running') return { label: '后台运行', tone: 'busy' }
  if (parsed.state === 'done') return { label: '完成', tone: 'ok' }
  if (parsed.state === 'error') return { label: '失败', tone: 'error' }
  return { label: '结果', tone: 'muted' }
}

function resultTextOf(block: Any): string {
  const content = block?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item: Any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: Any) => item.text)
    .join('\n')
}

export function MediaJobCard(props: Any): React.ReactElement {
  const phase = phaseOf(props)
  const block = props.block
  const args = block?.args ?? block?.arguments ?? {}
  const text = React.useMemo(() => (phase === 'result' ? resultTextOf(block) : ''), [phase, block])
  const parsed = React.useMemo(() => parseMediaJobResult(text), [text])
  const status = statusOf(phase, block, parsed)

  const isAudio = /huabu_audio_generate/.test(block?.name ?? '') || /huabu_audio_generate/.test(text)
  const toolName = isAudio ? 'huabu_audio_generate' : 'huabu_video_generate'

  const head = (
    <div className="huabu-bk-head">
      <span className="huabu-bk-tool">{toolName}</span>
      {parsed.provider && (
        <span className="huabu-bk-action">
          {parsed.provider}
          {parsed.model ? `/${parsed.model}` : ''}
        </span>
      )}
      <span className="huabu-bk-status" data-tone={status.tone}>
        {status.label}
      </span>
    </div>
  )

  const params = (
    <div className="huabu-bk-params">
      {typeof args.ratio === 'string' && args.ratio && (
        <span className="huabu-bk-param">
          <span className="huabu-bk-param-key">比例</span>
          <code>{args.ratio}</code>
        </span>
      )}
      {typeof args.duration_seconds === 'number' && (
        <span className="huabu-bk-param">
          <span className="huabu-bk-param-key">时长</span>
          <code>{args.duration_seconds}s</code>
        </span>
      )}
      {typeof args.name === 'string' && args.name && (
        <span className="huabu-bk-param">
          <span className="huabu-bk-param-key">命名</span>
          <code>{args.name}</code>
        </span>
      )}
      {(Array.isArray(args.reference_images) ? args.reference_images.length : 0) > 0 && (
        <span className="huabu-bk-param">
          <span className="huabu-bk-param-key">参考</span>
          <code>{args.reference_images.length} 项</code>
        </span>
      )}
    </div>
  )

  const promptSummary =
    typeof args.prompt === 'string' && args.prompt ? args.prompt.slice(0, 80) : ''

  if (phase !== 'result') {
    return (
      <div className="huabu-video-card" data-huabu-video-card data-huabu-phase={phase}>
        {head}
        <div className="huabu-bk-hint">{promptSummary ? `「${promptSummary}」` : '工具参数准备中…'}</div>
        {params}
      </div>
    )
  }

  if (block?.isError) {
    const message =
      (typeof block?.error?.message === 'string' && block.error.message) ||
      (text.split('\n').find((line: string) => line.trim() !== '') ?? '工具执行失败')
    return (
      <div className="huabu-video-card" data-huabu-video-card data-huabu-phase={phase} data-huabu-state="error">
        {head}
        <div className="huabu-bk-error">{message.slice(0, 1000)}</div>
        {params}
      </div>
    )
  }

  return (
    <div className="huabu-video-card" data-huabu-video-card data-huabu-phase={phase} data-huabu-job={parsed.state}>
      {head}
      {parsed.state === 'confirm' && (
        <div className="huabu-bk-hint">
          视频生成成本高：等待用户确认。用户同意后模型会带 confirmed=true 重新调用（本卡不提交任务）。
        </div>
      )}
      {parsed.state === 'running' && (
        <>
          <div className="huabu-bk-progress" role="progressbar" aria-label="后台任务">
            <span className="huabu-bk-progress-bar" />
          </div>
          <div className="huabu-bk-note">后台任务 {parsed.jobId}：会话不被阻塞；完成后自动通知，用 job_output 读取结果。</div>
        </>
      )}
      {parsed.state === 'done' && (
        <div className="huabu-bk-note" title={parsed.artifactRelPath}>
          完成：{parsed.artifactRelPath}（同步模式）
        </div>
      )}
      {parsed.state === 'unknown' && <div className="huabu-bk-hint">{text.slice(0, 400)}</div>}
      {params}
      {text && (
        <details className="huabu-bk-details">
          <summary>原始结果</summary>
          <pre>{text.slice(0, 2000)}</pre>
        </details>
      )}
    </div>
  )
}