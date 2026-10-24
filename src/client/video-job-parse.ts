// huabu_video/audio_generate 工具卡的纯解析（无 React 依赖，node 单测可独立打包）。

/** 结果文本 → 卡片状态 */
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
