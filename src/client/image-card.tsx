// huabu_image_generate 的工具卡：preparing（参数摘要）/ start（不定进度）/ result
// （图片网格 + 实际参数 + 产物路径 + 原始结果）。图片来自 D2 回喂的 image block。
import * as React from 'react'
import { useAttachmentImages } from './attachments'
import { parseImageResult } from './image-parse'

type Any = Record<string, any>
type Phase = 'preparing' | 'start' | 'result'
type Tone = 'ok' | 'error' | 'busy' | 'muted'

function phaseOf(props: Any): Phase {
  return props.phase === 'preparing' ? 'preparing' : props.phase === 'start' ? 'start' : 'result'
}

function statusOf(phase: Phase, block: Any): { label: string; tone: Tone } {
  if (phase === 'preparing') return { label: '准备参数', tone: 'muted' }
  if (phase === 'start') return { label: '生成中', tone: 'busy' }
  if (block?.isError) return { label: '失败', tone: 'error' }
  return { label: '完成', tone: 'ok' }
}

function callArgsOf(block: Any): Any {
  const args = block?.args ?? block?.arguments ?? block?.call?.arguments
  return args && typeof args === 'object' ? args : {}
}

function resultTextOf(block: Any): string {
  const content = block?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item: Any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: Any) => item.text)
    .join('\n')
}

function truncateText(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function ImageCard(props: Any): React.ReactElement {
  const phase = phaseOf(props)
  const block = props.block
  const args = React.useMemo(() => callArgsOf(block), [block])
  const text = React.useMemo(() => (phase === 'result' ? resultTextOf(block) : ''), [phase, block])
  const parsed = React.useMemo(() => parseImageResult(text), [text])
  const status = statusOf(phase, block)
  const { urls, error: imageError } = useAttachmentImages(props, phase)

  const promptSummary = typeof args.prompt === 'string' && args.prompt ? truncateText(args.prompt, 80) : ''
  const refCount = Array.isArray(args.reference_images) ? args.reference_images.length : 0

  const head = (
    <div className="huabu-bk-head">
      <span className="huabu-bk-tool">huabu_image_generate</span>
      {(parsed.provider || args.provider) && (
        <span className="huabu-bk-action">
          {parsed.provider ?? args.provider}
          {parsed.model || args.model ? `/${parsed.model ?? args.model}` : ''}
        </span>
      )}
      <span className="huabu-bk-status" data-tone={status.tone}>
        {status.label}
      </span>
    </div>
  )

  const params = (
    <div className="huabu-bk-params">
      {args.ratio && (
        <span className="huabu-bk-param">
          <span className="huabu-bk-param-key">比例</span>
          <code>{String(args.ratio)}</code>
        </span>
      )}
      {args.name && (
        <span className="huabu-bk-param">
          <span className="huabu-bk-param-key">命名</span>
          <code>{String(args.name)}</code>
        </span>
      )}
      {refCount > 0 && (
        <span className="huabu-bk-param">
          <span className="huabu-bk-param-key">垫图</span>
          <code>{refCount} 张</code>
        </span>
      )}
    </div>
  )

  if (phase === 'preparing') {
    return (
      <div className="huabu-image-card" data-huabu-image-card data-huabu-phase={phase}>
        {head}
        <div className="huabu-bk-hint">{promptSummary ? `「${promptSummary}」` : '工具参数准备中…'}</div>
        {params}
      </div>
    )
  }

  if (phase === 'start') {
    return (
      <div className="huabu-image-card" data-huabu-image-card data-huabu-phase={phase}>
        {head}
        <div className="huabu-bk-progress" role="progressbar" aria-label="生成中">
          <span className="huabu-bk-progress-bar" />
        </div>
        <div className="huabu-bk-hint">图片生成中（同步等待，完成后自动显示）；当前供应商无逐帧进度。</div>
        {params}
      </div>
    )
  }

  if (block?.isError) {
    const message =
      (typeof block?.error?.message === 'string' && block.error.message) ||
      (text.split('\n').find((line: string) => line.trim() !== '') ?? '工具执行失败')
    return (
      <div className="huabu-image-card" data-huabu-image-card data-huabu-phase={phase} data-huabu-state="error">
        {head}
        <div className="huabu-bk-error">{truncateText(message, 1000)}</div>
        {params}
      </div>
    )
  }

  return (
    <div className="huabu-image-card" data-huabu-image-card data-huabu-phase={phase}>
      {head}
      {(urls.length > 0 || imageError) && (
        <div className="huabu-im-grid">
          {urls.map((url, index) => (
            <img key={index} className="huabu-im-img" src={url} alt={`generated-${index}`} />
          ))}
        </div>
      )}
      {imageError && <div className="huabu-bk-error">loadImage error: {imageError}</div>}
      <div className="huabu-bk-chips">
        {parsed.dimensions && (
          <span className="huabu-bk-chip">
            <span className="huabu-bk-chip-label">实际</span>
            <span className="huabu-bk-chip-value">{parsed.dimensions}</span>
          </span>
        )}
        {parsed.ratio && (
          <span className="huabu-bk-chip">
            <span className="huabu-bk-chip-label">比例</span>
            <span className="huabu-bk-chip-value">{parsed.ratio}</span>
          </span>
        )}
        {parsed.sizeKb && (
          <span className="huabu-bk-chip">
            <span className="huabu-bk-chip-label">大小</span>
            <span className="huabu-bk-chip-value">{parsed.sizeKb}KB</span>
          </span>
        )}
      </div>
      {parsed.artifactRelPath && (
        <div className="huabu-bk-note" title={parsed.artifactRelPath}>
          已归档：{parsed.artifactRelPath}
        </div>
      )}
      {text && (
        <details className="huabu-bk-details">
          <summary>原始结果</summary>
          <pre>{truncateText(text)}</pre>
        </details>
      )}
    </div>
  )
}