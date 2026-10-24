// huabu_image_generate 工具卡的纯解析（无 React 依赖，node 单测可跑）。

/** 从结果文本解析读数（provider/model 头 + 生成完成行）；各字段独立提取，避免懒惰匹配截断 */
export function parseImageResult(text: string): {
  header: string
  provider?: string
  model?: string
  artifactRelPath?: string
  dimensions?: string
  ratio?: string
  sizeKb?: string
} {
  const headerLine = text.split('\n')[0] ?? ''
  const headerMatch = /^\[huabu_image_generate · ([^/\]]+)\/([^\]]+)\]/.exec(headerLine)
  const pathMatch = /生成完成：([^，\s。]+)/.exec(text)
  const dimsMatch = /实际 (\d+×\d+)px/.exec(text)
  const ratioMatch = /（比例 ([0-9:]+)）/.exec(text)
  const sizeMatch = /大小 (\d+)KB/.exec(text)
  return {
    header: headerLine,
    ...(headerMatch ? { provider: headerMatch[1], model: headerMatch[2] } : {}),
    ...(pathMatch ? { artifactRelPath: pathMatch[1] } : {}),
    ...(dimsMatch ? { dimensions: dimsMatch[1] } : {}),
    ...(ratioMatch ? { ratio: ratioMatch[1] } : {}),
    ...(sizeMatch ? { sizeKb: sizeMatch[1] } : {}),
  }
}

/** 调用参数摘要（preparing/start 态展示） */
export function imageArgSummary(args: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  if (typeof args.ratio === 'string' && args.ratio) rows.push(['比例', args.ratio])
  if (typeof args.name === 'string' && args.name) rows.push(['命名', args.name])
  const refs = Array.isArray(args.reference_images) ? args.reference_images.length : 0
  if (refs > 0) rows.push(['垫图', `${refs} 张`])
  return rows
}