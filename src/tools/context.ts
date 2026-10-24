// C3 huabu_context 工具：模型不确定项目里有什么时主动取全量态势。
// 每轮注入的短摘要（C4）与这里共用 services/context.ts 的构建口径。
import type { AssetsService } from '../services/assets'
import { contextText } from '../services/context'
import type { WorkingDirectoryLike } from '../services/session-cwd'

/** DSH execute 的 exec 形状（类型层只有 cwd；运行时 agent/signal 由宿主提供，见 A4/B2 契约） */
export interface ContextToolExecLike {
  cwd?: string
  agent?: unknown
  signal?: AbortSignal
}

export const CONTEXT_TOOL_NAME = 'huabu_context'

export interface ContextToolContext {
  workingDirectory?: WorkingDirectoryLike
}

export interface ContextToolValue {
  tool: string
  ok: boolean
  text: string
}

const SCOPES = ['assets', 'board', 'all'] as const

export function assembleContextTool(ctx: ContextToolContext, service: Pick<AssetsService, 'forExec'>) {
  return {
    name: CONTEXT_TOOL_NAME,
    description:
      '查看 Huabu 项目态势：素材库摘要（按分类计数 + 最近条目）与画布状态。' +
      '不确定项目里有什么素材/产物时调它；只要清单明细用 huabu_asset_list。',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description: 'assets=只看素材库 / board=只看画布 / all=全部（默认）',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { tool: { type: 'string' }, ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['tool', 'ok', 'text'],
      },
      render(_args: Record<string, unknown>, value: ContextToolValue) {
        return [{ type: 'text', text: value.text }]
      },
    },
    timeoutMs: 10_000,
    async execute(rawArgs: Record<string, unknown>, exec: ContextToolExecLike): Promise<ContextToolValue> {
      const scope = rawArgs.scope === undefined || rawArgs.scope === null ? 'all' : rawArgs.scope
      if (typeof scope !== 'string' || !(SCOPES as readonly string[]).includes(scope)) {
        throw new Error(`未知 scope：「${String(scope)}」；可用：${SCOPES.join(' / ')}`)
      }
      const assets = await service.forExec(ctx, exec)
      const value: ContextToolValue = {
        tool: CONTEXT_TOOL_NAME,
        ok: true,
        text: contextText(assets, scope as (typeof SCOPES)[number]),
      }
      return JSON.parse(JSON.stringify(value)) as ContextToolValue
    },
  }
}