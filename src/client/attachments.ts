// 工具卡共享的附件加载：从 result block.content[] 取 image 块的 attachmentId，
// 经宿主 props.loadImage 换 blob/data URL。A4 实测：入参优先 {sessionId, attachmentId}。
import * as React from 'react'

type Any = Record<string, any>

export interface BlockImageRef {
  attachmentId: string
  ref: Any
}

export function extractImageRefs(block: Any | undefined): BlockImageRef[] {
  const content = block?.content
  if (!Array.isArray(content)) return []
  const out: BlockImageRef[] = []
  for (const item of content) {
    const id = item?.attachment?.attachmentId
    if (item?.type === 'image' && typeof id === 'string') {
      out.push({ attachmentId: id, ref: item.attachment })
    }
  }
  return out
}

export function toSrc(loaded: Any): string {
  if (typeof loaded === 'string') return loaded
  if (loaded?.data) {
    const mime = loaded.attachment?.mediaType ?? 'image/png'
    return `data:${mime};base64,${loaded.data}`
  }
  return String(loaded?.url ?? loaded?.src ?? loaded)
}

export function useAttachmentImages(
  props: Any,
  phase: string,
): { refs: BlockImageRef[]; urls: string[]; error: string } {
  const refs = React.useMemo(
    () => (phase === 'result' ? extractImageRefs(props.block) : []),
    [phase, props.block],
  )
  const [urls, setUrls] = React.useState<string[]>([])
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    setUrls([])
    setError('')
    if (refs.length === 0) return
    if (typeof props.loadImage !== 'function') {
      setError('loadImage 不可用')
      return
    }
    let alive = true
    Promise.all(
      refs.map((r) =>
        typeof props.sessionId === 'string'
          ? props.loadImage({ sessionId: props.sessionId, attachmentId: r.attachmentId })
          : props.loadImage(r.attachmentId),
      ),
    )
      .then((loaded: Any[]) => {
        if (alive) setUrls(loaded.map(toSrc))
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [refs])

  return { refs, urls, error }
}
