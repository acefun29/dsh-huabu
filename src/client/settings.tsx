// G1/G2：设置分区实装（供应商/ffmpeg/开关/技能/权限/安装命令）+ locale 双语。
// 供应商表从媒体内置目录导入（单一事实来源）；文案走 ctx.locale.register 的 zh/en 字典。
import * as React from 'react'
import { BUILTIN_PROVIDERS } from '../media/catalog'

type Any = Record<string, any>

export const SETTINGS_LOCALE_NS = 'huabu.settings'

export const SETTINGS_ZH = {
  title: 'Huabu 画布能力',
  subtitle: '媒体生成 · 素材库 · blockout 运镜预演 · 视频理解',
  versionTitle: '版本与兼容',
  providersTitle: '媒体供应商与凭据',
  providersHint:
    '凭据不在插件侧存储：优先插件配置 media.apiKeys（profile cordis.patch.yml），或设环境变量后重启。默认供应商 mock（本地零成本，验证流程用）。',
  ffmpegTitle: 'ffmpeg（视频理解 / blockout 成片 / mock 视频）',
  ffmpegHint: '按顺序探测：插件配置 media.ffmpegPath → 环境变量 FFMPEG_PATH/FFMPEG → 插件依赖 ffmpeg-static → PATH。',
  togglesTitle: '开关（workspace.json / 插件配置）',
  toggles: [
    'media.confirmVideo（默认 true）：视频生成前需用户确认',
    'media.agentProvider / media.agentModels：默认生成供应商与模型（不配 = mock）',
    'media.defaultLibraryId / kindLibraryDefaults：产物落库目录',
    '插件配置 injectDigest（默认 true）/ digestBudgetTokens：每轮素材摘要注入',
    '插件配置 installSkills（默认 true）：huabu-blockout / huabu-media 技能安装',
  ],
  skillsTitle: '技能',
  skillsHint: '安装于 $DSH_HOME/skills/huabu-blockout 与 huabu-media（版本变化自动覆盖；重启 DSH 生效）。',
  permissionsTitle: '出网权限（媒体网关白名单）',
  installTitle: '安装',
}

export const SETTINGS_EN = {
  title: 'Huabu Canvas Capabilities',
  subtitle: 'Media generation · Asset library · Blockout previz · Video understanding',
  versionTitle: 'Version & compatibility',
  providersTitle: 'Media providers & credentials',
  providersHint:
    'Credentials are never stored by the plugin: set plugin config media.apiKeys (profile cordis.patch.yml), or export the env var and restart. Default provider is mock (local, zero cost, for pipeline validation).',
  ffmpegTitle: 'ffmpeg (video understanding / blockout rendering / mock video)',
  ffmpegHint: 'Probe order: plugin config media.ffmpegPath → env FFMPEG_PATH/FFMPEG → bundled ffmpeg-static → PATH.',
  togglesTitle: 'Switches (workspace.json / plugin config)',
  toggles: [
    'media.confirmVideo (default true): user confirmation before video generation',
    'media.agentProvider / media.agentModels: default generation provider/model (unset = mock)',
    'media.defaultLibraryId / kindLibraryDefaults: artifact output library',
    'Plugin config injectDigest (default true) / digestBudgetTokens: per-turn asset digest',
    'Plugin config installSkills (default true): install huabu-blockout / huabu-media skills',
  ],
  skillsTitle: 'Skills',
  skillsHint: 'Installed at $DSH_HOME/skills/huabu-blockout and huabu-media (overwritten on version change; restart DSH to apply).',
  permissionsTitle: 'Network permissions (media gateway allowlist)',
  installTitle: 'Install',
}

/** 出网白名单（与 package.json dshhub.permissions.network 保持一致） */
export const NETWORK_HOSTS = [
  'https://dashscope.aliyuncs.com',
  'https://ark.cn-beijing.volces.com',
  'https://open.volcengineapi.com',
  'https://api.minimaxi.com',
  'https://hunyuan.tencentcloudapi.com',
  'https://api.openai.com',
  'https://fal.run',
  'https://queue.fal.run',
]

export const PLUGIN_VERSION = '0.1.0'
export const DSH_ENGINES = '>=0.2.0-rc.1 <0.3.0-0'

export function HuabuSettingsSection(props: Any): React.ReactElement {
  // t = ctx.locale.bind(NS)：按当前语言取键值；toggles 等数组值原样透传
  const t = props.t as (key: string) => any
  return (
    <div className="huabu-settings-section" data-huabu-settings="huabu">
      <div className="huabu-settings-title">{t('title')}</div>
      <div className="huabu-settings-subtitle">{t('subtitle')}</div>

      <div className="huabu-settings-card">
        <div className="huabu-settings-card-title">{t('versionTitle')}</div>
        <div className="huabu-settings-row">
          dsh-huabu <code>{PLUGIN_VERSION}</code> · DSH <code>{DSH_ENGINES}</code>
        </div>
      </div>

      <div className="huabu-settings-card">
        <div className="huabu-settings-card-title">{t('providersTitle')}</div>
        <div className="huabu-settings-row huabu-settings-hint">{t('providersHint')}</div>
        <table className="huabu-settings-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Env</th>
              <th>Models</th>
            </tr>
          </thead>
          <tbody>
            {BUILTIN_PROVIDERS.map((provider) => (
              <tr key={provider.id}>
                <td>
                  {provider.label}（<code>{provider.id}</code>）
                </td>
                <td>
                  <code>{provider.auth.env}</code>
                </td>
                <td>{provider.models.length}</td>
              </tr>
            ))}
            <tr>
              <td>Mock（本地零成本）</td>
              <td>
                <code>—</code>
              </td>
              <td>3</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="huabu-settings-card">
        <div className="huabu-settings-card-title">{t('ffmpegTitle')}</div>
        <div className="huabu-settings-row huabu-settings-hint">{t('ffmpegHint')}</div>
      </div>

      <div className="huabu-settings-card">
        <div className="huabu-settings-card-title">{t('togglesTitle')}</div>
        <ul className="huabu-settings-list">
          {((t('toggles') as string[]) ?? []).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <div className="huabu-settings-card">
        <div className="huabu-settings-card-title">{t('skillsTitle')}</div>
        <div className="huabu-settings-row huabu-settings-hint">{t('skillsHint')}</div>
      </div>

      <div className="huabu-settings-card">
        <div className="huabu-settings-card-title">{t('permissionsTitle')}</div>
        <ul className="huabu-settings-list">
          {NETWORK_HOSTS.map((host) => (
            <li key={host}>
              <code>{host}</code>
            </li>
          ))}
        </ul>
      </div>

      <div className="huabu-settings-card">
        <div className="huabu-settings-card-title">{t('installTitle')}</div>
        <div className="huabu-settings-row">
          <code>dsh plugin --profile web add link:&lt;本插件目录&gt;</code>
        </div>
      </div>
    </div>
  )
}
