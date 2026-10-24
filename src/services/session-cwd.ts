// 会话工作区解析：A4 契约 #5 —— exec.cwd 是宿主进程 cwd，不能当会话工作区。
// working_directory 工具的官方写法（app.asar 核实）；blockout 与 project 共用。
export interface WorkingDirectoryLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

export interface ToolExecLike {
  agent?: unknown
  signal?: AbortSignal
}

/** 从工具 exec 里取真实会话工作区 */
export async function resolveSessionCwd(
  ctx: { workingDirectory?: WorkingDirectoryLike },
  exec: ToolExecLike,
): Promise<string> {
  const workingDirectory = ctx.workingDirectory
  if (!workingDirectory) {
    throw new Error('workingDirectory 服务不可用：插件 inject 需要包含 workingDirectory')
  }
  if (exec.agent === undefined || exec.agent === null) {
    throw new Error('当前工具调用没有 agent 会话，无法确定会话工作区')
  }
  return await workingDirectory.ensure(exec.agent, exec.signal)
}
