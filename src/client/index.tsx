// dsh-huabu client 入口。
// A4：huabu_probe 的最小 toolview 探针卡——
//   ① 把宿主给的 props 键与 block 形状渲染成文本（供 DOM 快照读取，关闭 G4b 的形状未知）；
//   ② 从 block.content[] 取 image 块的 attachmentId，逐个调 props.loadImage 渲染 <img>（关闭 G4a：多图）；
//   ③ 出错全部内联显示。
// loadImage 契约（A4 从 dsh-api-remotes 源码核实）：
//   入参 attachmentId（sha256 引用，绝非文件路径），返回 { attachment: ref, data: base64 }。
// A5：导航绑定（G4d / G4e）——
//   `sidebar.panellist` 的 id 与 `main` 的 key 共用同一常量 PANEL_ID，点击侧栏行由宿主调
//   ctx.layout.selectPanel(id)，再按 id 在该 keyed 槽里找同 key 的面板（对不上宿主抛错，实测见 A5 证据）。
//   设置分区注册到 `settings.section`（list 槽，导航行由 ui-settings 壳渲染，我们只交内容）。
// 样式纪律：类名统一 huabu- 前缀；颜色只用宿主 --dsw-alias-* / --dsw-static-* 令牌，
// --huabu-* 只放布局尺寸。样式本体在 theme.css（A6），apply 时注入。
import * as React from 'react'
import themeCss from './theme.css'
import { useAttachmentImages } from './attachments'
import { BlockoutCard } from './blockout-card'
import { ImageCard } from './image-card'
import { MediaJobCard } from './video-card'
import { HuabuSettingsSection, SETTINGS_EN, SETTINGS_ZH, SETTINGS_LOCALE_NS } from './settings'

// layout 服务由宿主 ui-layout 提供（面板切换用），必须先 inject 才能访问 ctx.layout
export const inject = ['slots', 'locale', 'layout']

/** 全局面板 id：sidebar.panellist 的 id、main 的 key、settings.section 的 id 三处共用 */
const PANEL_ID = 'huabu'
/** 注入的主题样式节点 id（同时用作 data-huabu-theme 的探针标记） */
const THEME_STYLE_ID = 'dsh-huabu-theme'
/** 侧栏「全局面板」列表里的位置：排在宿主自带插件页（order 10）之后 */
const PANEL_ORDER = 500
/** 设置左侧导航里的位置：账号(10)/通用/模型/插件(15) 之后 */
const SETTINGS_ORDER = 60

type Any = Record<string, any>

/** 幂等注入 theme.css；重复 apply（热重载）时更新已有节点而不是叠加 */
function injectTheme(): void {
  if (typeof document === 'undefined') return
  let style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = THEME_STYLE_ID
    style.dataset.huabuTheme = PANEL_ID
    document.head.appendChild(style)
  }
  style.textContent = themeCss
}

function truncate(s: string, max = 1200): string {
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max})` : s
}

function HuabuProbeCard(props: Any) {
  const phase = String(props.phase ?? '?')
  const { refs, urls, error: loadError } = useAttachmentImages(props, phase)

  const block = props.block

  const blockDump = React.useMemo(
    () =>
      truncate((() => {
        try {
          return JSON.stringify(block)
        } catch {
          return String(block)
        }
      })()),
    [block],
  )

  return (
    <div className="huabu-probe-card" data-huabu-phase={phase}>
      <div className="huabu-probe-title">Huabu Probe Card（自定义 toolview）</div>
      <div className="huabu-probe-meta">
        phase={phase} · props 键：{Object.keys(props).join(', ')} · loadImage=
        {typeof props.loadImage} · cwd={String(props.cwd ?? '—')} · image 块 {refs.length} 个 · 已渲染 {urls.length} 张
      </div>
      <div className="huabu-probe-grid">
        {urls.map((u, i) => (
          <img key={i} className="huabu-probe-img" src={u} alt={`probe-${i}`} />
        ))}
      </div>
      {loadError && <div className="huabu-probe-error">loadImage error: {loadError}</div>}
      <details className="huabu-probe-dump">
        <summary>block dump（截断）</summary>
        <pre>{blockDump}</pre>
      </details>
    </div>
  )
}

/* ── A5：侧栏入口图标（全局面板的 glyph，由宿主 PanelRow 包在 button 里） ── */
function HuabuPanelIcon(props: Any) {
  const size = typeof props.size === 'number' ? props.size : 16
  return (
    <svg
      className="huabu-nav-icon"
      data-huabu-nav-icon={PANEL_ID}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect x="1.9" y="2.6" width="12.2" height="10.8" rx="2.2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M2.6 10.4 5.8 7.3l2.3 2.2 2.2-2.1 3.1 3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10.4" cy="5.6" r="1" fill="currentColor" />
    </svg>
  )
}

/* ── A5：中栏空面板（`main` keyed 槽，替换整个中栏） ── */
function HuabuPanel(props: Any) {
  const back = () => {
    if (typeof props.backToConversation === 'function') props.backToConversation()
  }
  return (
    <div className="huabu-panel" data-huabu-panel={PANEL_ID}>
      <div className="huabu-panel-header">
        <span className="huabu-panel-title">Huabu</span>
        <button type="button" className="huabu-panel-back" onClick={back}>
          返回对话
        </button>
      </div>
      <div className="huabu-panel-body">
        <div className="huabu-panel-placeholder">画布面板（占位）</div>
        <div className="huabu-panel-hint">
          A5 只验证导航绑定：点侧栏 Huabu 行切到这里，panel id = <code>{PANEL_ID}</code>。
          v0.2 的只读画布（H1）会挂在这一层。
        </div>
      </div>
    </div>
  )
}

/* ── A5：设置分区内容（导航行由宿主 ui-settings 壳渲染，我们只交内容） ── */
export function apply(ctx: Any): void {
  injectTheme()

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'huabu_probe' }, HuabuProbeCard))

  // B6：正式 blockout 工具卡（一个组件按 args.action 分支）
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'huabu_blockout' }, BlockoutCard))

  // D3：图片生成工具卡（复用 blockout 卡的读数/参数样式，图走 grid）
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'huabu_image_generate' }, ImageCard))

  // E4：视频/音频生成卡（同组件按 key 注册两次）
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'huabu_video_generate' }, MediaJobCard))
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'huabu_audio_generate' }, MediaJobCard))

  // A5 · G4d：main 的 key 与 sidebar.panellist 的 id 用同一常量绑定。
  // 宿主点击侧栏行 → ctx.layout.selectPanel(id) → 在 keyed 槽 `main` 里按 key 取面板。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        inject: () => ({
          backToConversation: () => {
            ctx.layout?.selectPanel?.(null)
          },
        }),
      },
      HuabuPanel,
    ))

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: 'Huabu' },
      HuabuPanelIcon,
    ))

  // A5 · G4e：设置分区（list 槽）；G1 实装内容 + G2 双语字典
  ctx.slots.inject('settings.section', () => {
    ctx.locale?.register?.(SETTINGS_LOCALE_NS, { zh: SETTINGS_ZH, en: SETTINGS_EN })
    const t = ctx.locale?.bind ? ctx.locale.bind(SETTINGS_LOCALE_NS) : (key: string) => (SETTINGS_ZH as Record<string, unknown>)[key]
    return ctx.slots.register(
      { name: 'settings.section', id: PANEL_ID, order: SETTINGS_ORDER, label: 'Huabu' },
      () => <HuabuSettingsSection t={t} />,
    )
  })
}