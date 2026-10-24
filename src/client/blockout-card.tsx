// huabu_blockout 的工具卡：preparing / start / result 三态，按 action 分支渲染
// 拼版图、读数、逐帧/镜头表、违规列表；result 的图来自 B4 回喂的 image block。
import * as React from 'react'
import { useAttachmentImages } from './attachments'
import {
  formatNumber,
  formatRange,
  issueMessages,
  parseCallArgs,
  parseEngineResult,
  readResultText,
  resolveAction,
  truncateText,
} from './blockout-parse'

type Any = Record<string, any>
type Phase = 'preparing' | 'start' | 'result'
type Tone = 'ok' | 'warn' | 'error' | 'busy' | 'muted'

function phaseOf(props: Any): Phase {
  return props.phase === 'preparing' ? 'preparing' : props.phase === 'start' ? 'start' : 'result'
}

function statusOf(phase: Phase, block: Any, header: string, data: Any | null): { label: string; tone: Tone } {
  if (phase === 'preparing') return { label: '准备参数', tone: 'muted' }
  if (phase === 'start') return { label: '渲染中', tone: 'busy' }
  if (block?.isError) return { label: '失败', tone: 'error' }
  if (header.includes('解算有 error')) return { label: '解算错误', tone: 'error' }
  if (header.includes('约束违规') || data?.ok === false) return { label: '有违规', tone: 'warn' }
  return { label: '完成', tone: 'ok' }
}

function argSummary(args: Any): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  if (typeof args.scene === 'string' && args.scene) rows.push(['场景', args.scene])
  if (typeof args.shot === 'string' && args.shot) rows.push(['镜头', args.shot])
  if (typeof args.view === 'string' && args.view) rows.push(['视图', args.view])
  if (args.keyframes === true) rows.push(['关键帧', '是'])
  if (typeof args.size === 'number') rows.push(['拼版', `${args.size}px`])
  if (typeof args.width === 'number' || typeof args.height === 'number') {
    rows.push(['画幅', `${args.width ?? '?'}×${args.height ?? '?'}`])
  }
  if (typeof args.out === 'string' && args.out) rows.push(['输出', args.out])
  if (args.publish === false) rows.push(['发布', '否'])
  return rows
}

function Chip({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <span className="huabu-bk-chip">
      <span className="huabu-bk-chip-label">{label}</span>
      <span className="huabu-bk-chip-value">{String(value)}</span>
    </span>
  )
}

function Params({ args }: { args: Any }) {
  const rows = argSummary(args)
  if (rows.length === 0) return null
  return (
    <div className="huabu-bk-params">
      {rows.map(([key, value]) => (
        <span key={key} className="huabu-bk-param">
          <span className="huabu-bk-param-key">{key}</span>
          <code title={value}>{value}</code>
        </span>
      ))}
    </div>
  )
}

function Issues({ title, level, items }: { title: string; level: 'error' | 'warn'; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="huabu-bk-issues" data-level={level}>
      <div className="huabu-bk-issues-title">{title}</div>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function ShotTable({ shots }: { shots: Any[] }) {
  if (shots.length === 0) return null
  return (
    <table className="huabu-bk-table">
      <thead>
        <tr>
          <th>镜头</th>
          <th>帧</th>
          <th>时长</th>
          <th>error</th>
          <th>warn</th>
        </tr>
      </thead>
      <tbody>
        {shots.map((shot, index) => (
          <tr key={String(shot?.id ?? index)}>
            <td>{String(shot?.id ?? '—')}</td>
            <td>{String(shot?.frames ?? '—')}</td>
            <td>{typeof shot?.durationS === 'number' ? `${shot.durationS}s` : '—'}</td>
            <td>{Array.isArray(shot?.errors) ? shot.errors.length : 0}</td>
            <td>{Array.isArray(shot?.warnings) ? shot.warnings.length : 0}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Metrics({ action, data }: { action: string; data: Any }) {
  if (action === 'sheet') {
    return (
      <div className="huabu-bk-chips">
        <Chip label="主体" value={data.subject?.id} />
        <Chip label="画幅" value={data.width && data.height ? `${data.width}×${data.height}` : undefined} />
        <Chip label="视图" value={Array.isArray(data.cells) ? `${data.cells.length} 个` : undefined} />
        <Chip label="大小" value={typeof data.bytes === 'number' ? `${Math.round(data.bytes / 1024)}KB` : undefined} />
        <Chip label="耗时" value={typeof data.ms === 'number' ? `${data.ms}ms` : undefined} />
      </div>
    )
  }

  if (action === 'view') {
    const camera = (data.camera ?? {}) as Any
    return (
      <div className="huabu-bk-chips">
        <Chip label="视图" value={data.view} />
        <Chip label="镜头" value={typeof camera.lens === 'number' ? `${camera.lens}mm` : undefined} />
        <Chip label="画幅" value={camera.width && camera.height ? `${camera.width}×${camera.height}` : undefined} />
        <Chip label="耗时" value={typeof data.ms === 'number' ? `${data.ms}ms` : undefined} />
      </div>
    )
  }

  if (action === 'shot') {
    const metrics = (data.metrics ?? {}) as Any
    return (
      <>
        <div className="huabu-bk-chips">
          <Chip label="结果" value={data.ok ? '通过' : '有违规'} />
          <Chip label="帧" value={data.frames} />
          <Chip label="fps" value={data.fps} />
          <Chip label="时长" value={typeof data.durationS === 'number' ? `${data.durationS}s` : undefined} />
          <Chip label="fill" value={formatRange(metrics.fillRange, 4)} />
          <Chip
            label="可见"
            value={typeof metrics.minSubjectVisiblePct === 'number' ? `≥${formatNumber(metrics.minSubjectVisiblePct)}%` : undefined}
          />
          <Chip label="最大速度" value={typeof metrics.maxSpeedMps === 'number' ? `${formatNumber(metrics.maxSpeedMps, 3)}m/s` : undefined} />
        </div>
        {data.corrected === true && <div className="huabu-bk-note">autofix 已修正 {Array.isArray(data.corrections) ? data.corrections.length : 0} 处执行质量问题</div>}
        <Issues title="error" level="error" items={issueMessages(data.errors)} />
        <Issues title="warn" level="warn" items={issueMessages(data.warnings)} />
      </>
    )
  }

  if (action === 'shots') {
    const shots = Array.isArray(data.shots) ? (data.shots as Any[]) : []
    const continuity = issueMessages(data.continuity, 3)
    return (
      <>
        <div className="huabu-bk-chips">
          <Chip label="镜头" value={shots.length} />
          <Chip label="连续性" value={continuity.length > 0 ? `${continuity.length} 条` : '通过'} />
        </div>
        <ShotTable shots={shots} />
        <Issues title="连续性" level="warn" items={continuity} />
      </>
    )
  }

  if (action === 'check') {
    return (
      <>
        <div className="huabu-bk-chips">
          <Chip label="部件" value={data.partCount} />
          <Chip label="碰撞对" value={Array.isArray(data.collisions) ? data.collisions.length : 0} />
          <Chip label="error" value={Array.isArray(data.errors) ? data.errors.length : 0} />
          <Chip label="warn" value={Array.isArray(data.warnings) ? data.warnings.length : 0} />
        </div>
        <Issues title="error" level="error" items={issueMessages(data.errors)} />
        <Issues title="warn" level="warn" items={issueMessages(data.warnings)} />
      </>
    )
  }

  if (action === 'describe') {
    return (
      <div className="huabu-bk-chips">
        <Chip label="部件" value={data.partCount} />
        <Chip label="驱动" value={data.driverCount} />
        <Chip label="实例" value={Array.isArray(data.instances) ? data.instances.join(', ') : undefined} />
      </div>
    )
  }

  if (action === 'video') {
    return (
      <>
        <div className="huabu-bk-chips">
          <Chip label="帧" value={data.frames} />
          <Chip label="fps" value={data.fps} />
          <Chip label="时长" value={typeof data.durationS === 'number' ? `${data.durationS}s` : undefined} />
          <Chip label="分辨率" value={Array.isArray(data.resolution) ? data.resolution.join('×') : undefined} />
          <Chip label="渲染" value={typeof data.renderMs === 'number' ? `${Math.round(data.renderMs / 1000)}s` : undefined} />
        </div>
        <Issues title="error" level="error" items={issueMessages(data.errors)} />
        <Issues title="warn" level="warn" items={issueMessages(data.warnings)} />
      </>
    )
  }

  return (
    <div className="huabu-bk-chips">
      <Chip label="结果" value={data.ok === false ? '有错误' : '完成'} />
    </div>
  )
}

function artifactPathOf(data: Any | null | undefined): string | undefined {
  for (const key of ['image', 'video', 'writtenTo']) {
    if (typeof data?.[key] === 'string' && data[key]) return data[key]
  }
  return undefined
}

export function BlockoutCard(props: Any): React.ReactElement {
  const phase = phaseOf(props)
  const block = props.block
  const args = React.useMemo(() => parseCallArgs(block), [block])
  const text = React.useMemo(() => (phase === 'result' ? readResultText(block) : ''), [phase, block])
  const parsed = React.useMemo(() => parseEngineResult(text), [text])
  const action = resolveAction(args, parsed.header)
  const status = statusOf(phase, block, parsed.header, parsed.data)
  const { refs, urls, error: imageError } = useAttachmentImages(props, phase)
  const scene = typeof args.scene === 'string' ? args.scene : ''

  const head = (
    <div className="huabu-bk-head">
      <span className="huabu-bk-tool">huabu_blockout</span>
      {action && <span className="huabu-bk-action">{action}</span>}
      <span className="huabu-bk-status" data-tone={status.tone}>
        {status.label}
      </span>
      {scene && (
        <span className="huabu-bk-scene" title={scene}>
          {scene}
        </span>
      )}
    </div>
  )

  if (phase === 'preparing') {
    return (
      <div className="huabu-blockout-card" data-huabu-blockout-card data-huabu-phase={phase}>
        {head}
        <div className="huabu-bk-hint">工具参数准备中…</div>
        <Params args={args} />
      </div>
    )
  }

  if (phase === 'start') {
    return (
      <div className="huabu-blockout-card" data-huabu-blockout-card data-huabu-phase={phase}>
        {head}
        <div className="huabu-bk-progress" role="progressbar" aria-label="渲染中">
          <span className="huabu-bk-progress-bar" />
        </div>
        <div className="huabu-bk-hint">
          {action === 'video'
            ? '视频渲染中：逐帧光栅化 + 编码，完成后自动显示成片信息（同步调用，完成前无法获得帧进度）。'
            : '引擎渲染中，完成后自动显示拼版与读数。'}
        </div>
        <Params args={args} />
      </div>
    )
  }

  if (block?.isError) {
    const message =
      (typeof block?.error?.message === 'string' && block.error.message) ||
      (text.split('\n').find((line) => line.trim() !== '') ?? '工具执行失败')
    return (
      <div className="huabu-blockout-card" data-huabu-blockout-card data-huabu-phase={phase} data-huabu-state="error">
        {head}
        <div className="huabu-bk-error">{truncateText(message, 1000)}</div>
        <Params args={args} />
      </div>
    )
  }

  const imagePath = artifactPathOf(parsed.data)
  const canOpen = typeof imagePath === 'string' && typeof props.openFile === 'function'
  // 图片已经显示时不再重复「图片已随本条结果附上」的说明；其它追加说明（如成片发布路径）保留
  const trailing = parsed.trailing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !(urls.length > 0 && line.startsWith('图片已随本条结果附上')))
    .join('\n')

  return (
    <div className="huabu-blockout-card" data-huabu-blockout-card data-huabu-phase={phase} data-huabu-action={action || 'unknown'}>
      {head}
      {(refs.length > 0 || urls.length > 0) && (
        <div className="huabu-bk-grid">
          {urls.map((url, index) => (
            <img key={index} className="huabu-bk-img" src={url} alt={`blockout-${action}-${index}`} />
          ))}
          {urls.length === 0 && !imageError && <div className="huabu-bk-hint">图片加载中…</div>}
        </div>
      )}
      {imageError && <div className="huabu-bk-error">loadImage error: {imageError}</div>}
      {parsed.data ? <Metrics action={action} data={parsed.data} /> : <div className="huabu-bk-hint">结果不是可解析的引擎 JSON，请展开原始结果。</div>}
      {trailing && <div className="huabu-bk-note">{trailing}</div>}
      {(canOpen || text) && (
        <div className="huabu-bk-actions">
          {canOpen && (
            <button
              type="button"
              className="huabu-bk-button"
              onClick={() => {
                try {
                  if (typeof imagePath === 'string') props.openFile(imagePath)
                } catch {
                  /* 打不开文件不影响读数 */
                }
              }}
            >
              打开产物
            </button>
          )}
          {text && (
            <details className="huabu-bk-details">
              <summary>原始结果</summary>
              <pre>{truncateText(text)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
