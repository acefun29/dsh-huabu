#!/usr/bin/env node
/**
 * ui-probe.mjs — 零依赖 CDP 驱动，验证 dsh-huabu A5 导航绑定 / A6 主题令牌（真机 Chrome/Edge）。
 *
 * 用法：
 *   node scripts/ui-probe.mjs --url 'http://127.0.0.1:8791/?token=...'
 *   node scripts/ui-probe.mjs --url '...' --dump
 *   node scripts/ui-probe.mjs --url '...' --expect-error 'huabu'
 *   node scripts/ui-probe.mjs --url '...' --theme
 *
 * 依赖：Node >= 22（全局 fetch / WebSocket），不安装任何 npm 包。
 *
 * 宿主 DOM 契约（从 dsh-client-ui-sidebar / dsh-client-ui-settings-general 的
 * lib/client.js bundle 反查确认；宿主升级后如断言失败，先跑 --dump 复核）：
 *   1. 侧栏全局面板行：button[aria-label="<label>"]，位于 nav[aria-label="全局面板"]
 *      （英文 locale 下 nav aria-label 为 "Global panels"）。选中后该 button 带
 *      aria-current="page"。宽态行有 glyph + 文本，窄态只有 glyph，但 aria-label 不变，
 *      所以断言只认 aria-label，不依赖文本节点。
 *   2. 侧栏展开/收起按钮：aria-label="打开侧边栏" / "收起侧边栏"（英文 Open/Collapse sidebar）。
 *      <1024px 视口侧栏会收成 56px rail，因此脚本先 Emulation.setDeviceMetricsOverride
 *      到 1440x900，再导航。
 *   3. 设置入口（两套宿主实现，脚本都兼容）：
 *      a) settings.launcher 未被接管时：侧栏底部 button[aria-label="设置"][aria-haspopup="dialog"]
 *         （英文 "Settings"）。
 *      b) 本 profile 实际命中的是 dsh-client-ui-settings-account 接管 settings.launcher 的情形：
 *         侧栏底部是账号菜单 button[aria-label="账号菜单"][aria-haspopup="menu"]
 *         （英文 "Account menu"），点开后 role=menu 里的 menuitem「设置」才打开设置。
 *         所以只用 button[aria-label="设置"] 会找不到入口 —— 别踩这个坑。
 *      两种入口都没有别的稳定 class（CSS module hash 每次构建会变）。
 *   4. 设置面板：div[role="dialog"]（居中 modal），左侧分区导航是 div[role="dialog"] nav
 *      里的 button 列表，文本为中文分区名；Huabu 分区行 = 该 dialog 内 textContent 规范化后
 *      等于 "Huabu" 的 button。点击后内容区出现 [data-huabu-settings="huabu"]。
 *   5. 全新临时 profile 首屏会弹「预览版说明」role=dialog（一次性的产品说明），
 *      不点「继续」它会挡住真实点击，脚本在启动阶段自动关掉；随后还会弹「开始使用」
 *      （登录 / 添加 API Key），同样循环关掉。
 *   6. 中栏面板：[data-huabu-panel="huabu"]；返回按钮 .huabu-panel-back。
 *
 * 退出码：0 全通过；1 断言失败；2 --expect-error 未命中；3 仅 --strict-console 下的控制台错误。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const TOOL = 'dsh-huabu/ui-probe'
const VERSION = '1.1.0'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`ui-probe.mjs v${VERSION} — dsh-huabu A5 导航绑定实测探针

用法:
  node scripts/ui-probe.mjs --url <url> [options]

选项:
  --url <url>            必填。DSH web 地址（带 token）。
  --out <dir>            截图与 JSON 输出目录，默认 smoke/（相对 cwd）。
  --width <n>            视口宽，默认 1440（<1024 侧栏会收成 rail）。
  --height <n>           视口高，默认 900。
  --timeout <ms>         页面启动等待上限，默认 30000。
  --chrome <path>        Chrome/Edge 可执行文件；默认从 PROGRAMFILES / CHROME_PATH 探测。
  --dump                 只打印侧栏/设置相关的按钮候选（文本、aria-label、class、rect），不做断言。
  --expect-error <str>   点侧栏 Huabu 行后，若控制台异常含该子串则 exit 0 并写 a5-id-mismatch.txt，否则 exit 2。
  --theme                A6 深浅色断言：注入节点、面板/设置分区的令牌色与截图（a6-*.png / a6-probe.json）。
  --strict-console       控制台存在 error 时以 exit 3 失败（默认仅记录不失败）。
  --keep-temp            保留临时 user-data-dir（默认删除）。
  -h, --help             显示帮助。
`)
}

function die(msg) {
  console.error(`[ui-probe] error: ${msg}`)
  process.exit(64)
}

function parseArgs(argv) {
  const opts = {
    url: null,
    out: 'smoke',
    width: 1440,
    height: 900,
    timeout: 30000,
    chrome: null,
    dump: false,
    expectError: null,
    theme: false,
    strictConsole: false,
    keepTemp: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (v === undefined) die(`missing value for ${a}`)
      return v
    }
    switch (a) {
      case '--url': opts.url = val(); break
      case '--out': opts.out = val(); break
      case '--width': opts.width = Number(val()); break
      case '--height': opts.height = Number(val()); break
      case '--timeout': opts.timeout = Number(val()); break
      case '--chrome': opts.chrome = val(); break
      case '--dump': opts.dump = true; break
      case '--expect-error': opts.expectError = val(); break
      case '--theme': opts.theme = true; break
      case '--strict-console': opts.strictConsole = true; break
      case '--keep-temp': opts.keepTemp = true; break
      case '-h':
      case '--help': usage(); process.exit(0); break
      default: die(`unknown arg: ${a}`)
    }
  }
  if (!Number.isFinite(opts.width) || opts.width < 320) die('--width must be >= 320')
  if (!Number.isFinite(opts.height) || opts.height < 240) die('--height must be >= 240')
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) die('--timeout must be > 0')
  if ([opts.dump, Boolean(opts.expectError), opts.theme].filter(Boolean).length > 1) {
    die('--dump / --expect-error / --theme 只能选一个')
  }
  return opts
}

// ---------------------------------------------------------------------------
// Chrome 启动 / 清理（不硬编码本机绝对路径）
// ---------------------------------------------------------------------------

function resolveChrome(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH)

  const programFiles = process.env.PROGRAMFILES
  const programFilesX86 = process.env['PROGRAMFILES(X86)']
  const localAppData = process.env.LOCALAPPDATA
  for (const base of [programFiles, programFilesX86, localAppData]) {
    if (!base) continue
    candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    candidates.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  // 非 Windows 环境（脚本可复跑在 CI/Linux/macOS）
  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  )

  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  throw new Error('找不到 Chrome/Edge。用 --chrome <path> 或环境变量 CHROME_PATH 指定。')
}

function chromeArgs(opts, userDataDir) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--mute-audio',
    '--hide-crash-restore-bubble',
    '--no-service-autorun',
    '--disable-features=Translate,MediaRouter',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    `--window-size=${opts.width},${opts.height}`,
    'about:blank',
  ]
}

async function launchChrome(opts) {
  const chromePath = resolveChrome(opts.chrome)
  const userDataDir = join(tmpdir(), `dsh-ui-probe-${randomBytes(6).toString('hex')}`)
  mkdirSync(userDataDir, { recursive: true })

  const proc = spawn(chromePath, chromeArgs(opts, userDataDir), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stderr = ''
  let wsUrl = null
  let settled = false
  let resolveWs
  let rejectWs
  const wsPromise = new Promise((res, rej) => {
    resolveWs = res
    rejectWs = rej
  })

  const onChunk = (chunk) => {
    const text = chunk.toString()
    stderr += text
    if (wsUrl || settled) return
    const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
    if (m) {
      wsUrl = m[1]
      settled = true
      resolveWs(wsUrl)
    }
  }
  proc.stdout.on('data', onChunk)
  proc.stderr.on('data', onChunk)
  proc.on('error', (err) => {
    if (settled) return
    settled = true
    rejectWs(new Error(`Chrome 启动失败: ${err.message}`))
  })
  proc.on('exit', (code) => {
    if (settled) return
    settled = true
    rejectWs(new Error(`Chrome 提前退出（code=${code}）\n--- chrome stderr ---\n${stderr.slice(-4000)}`))
  })

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    rejectWs(new Error(`等待 "DevTools listening on ws://…" 超时（20s）\n--- chrome stderr ---\n${stderr.slice(-4000)}`))
  }, 20000)

  try {
    wsUrl = await wsPromise
  } finally {
    clearTimeout(timer)
  }

  return { chromePath, proc, userDataDir, wsUrl, getStderr: () => stderr }
}

function cleanupChrome(handle, keepTemp) {
  if (!handle) return
  try {
    handle.proc.kill()
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32' && handle.proc.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(handle.proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
  }
  if (!keepTemp && handle.userDataDir) {
    try {
      rmSync(handle.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
    } catch {
      /* Windows 下偶尔文件仍被占用，忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端（flatten 模式，一个 browser ws 上带 sessionId 发 page 命令）
// ---------------------------------------------------------------------------

class CDP {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Set()
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`))
        else p.resolve(msg.result)
        return
      }
      for (const fn of this.listeners) {
        try {
          fn(msg)
        } catch {
          /* listener 自身的错误不影响主流程 */
        }
      }
    })
    ws.addEventListener('close', () => {
      for (const [, p] of this.pending) p.reject(new Error(`${p.method}: CDP socket closed`))
      this.pending.clear()
    })
  }

  static async connect(url, timeoutMs = 15000) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`连接 CDP ws 超时: ${url}`)), timeoutMs)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(t)
          res()
        },
        { once: true },
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(t)
          rej(new Error(`连接 CDP ws 失败: ${url}`))
        },
        { once: true },
      )
    })
    return new CDP(ws)
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.seq
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(t)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(t)
          reject(e)
        },
      })
      this.ws.send(JSON.stringify(payload))
    })
  }

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 页面操作封装
// ---------------------------------------------------------------------------

async function waitUntil(desc, fn, timeoutMs = 15000, intervalMs = 120) {
  const started = Date.now()
  let lastErr = null
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      lastErr = err
    }
    await delay(intervalMs)
  }
  const suffix = lastErr ? `；最后一次错误：${lastErr.message}` : ''
  throw new Error(`等待「${desc}」超时（${timeoutMs}ms）${suffix}`)
}

/** 页面内可见 button 扫描（--dump / 失败诊断用）。 */
const SCAN_EXPR = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const desc = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
      ariaLabel: el.getAttribute('aria-label'),
      ariaCurrent: el.getAttribute('aria-current'),
      ariaHaspopup: el.getAttribute('aria-haspopup'),
      role: el.getAttribute('role'),
      cls: String(el.className || '').slice(0, 120),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  };
  const all = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible);
  const navs = Array.from(document.querySelectorAll('nav')).map((n) => ({
    ariaLabel: n.getAttribute('aria-label'),
    buttons: Array.from(n.querySelectorAll('button,[role="button"]')).filter(visible).map(desc),
  }));
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).map((d) => ({
    ariaLabel: d.getAttribute('aria-label'),
    ariaLabelledby: d.getAttribute('aria-labelledby'),
    buttons: Array.from(d.querySelectorAll('button,[role="button"]')).filter(visible).map(desc),
    text: (d.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
  }));
  const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(visible).map((m) => ({
    cls: String(m.className || '').slice(0, 120),
    text: (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    items: Array.from(m.querySelectorAll('[role="menuitem"],[role="option"],button,[role="button"]')).filter(visible).map(desc),
  }));
  return {
    title: document.title,
    href: location.href,
    readyState: document.readyState,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    buttonCount: all.length,
    navs,
    dialogs,
    menus,
    buttons: all.map(desc).slice(0, 200),
  };
})()`

class Page {
  constructor(cdp, sessionId, opts) {
    this.cdp = cdp
    this.sessionId = sessionId
    this.opts = opts
    this.viewport = { width: opts.width, height: opts.height }
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId)
  }

  async evaluate(expression, { awaitPromise = false, retries = 10 } = {}) {
    let lastErr = null
    for (let i = 0; i < retries; i++) {
      try {
        const res = await this.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise,
          userGesture: true,
        })
        if (res.exceptionDetails) {
          const d = res.exceptionDetails
          throw new Error(d.exception?.description || d.text || 'Runtime.evaluate 异常')
        }
        return res.result?.value
      } catch (err) {
        lastErr = err
        // 导航/上下文切换期间的暂时性错误：重试
        if (/context|destroyed|Cannot find|Target closed|Inspected target/i.test(err.message)) {
          await delay(120)
          continue
        }
        throw err
      }
    }
    throw lastErr
  }

  async waitUntil(desc, fn, timeoutMs) {
    return waitUntil(desc, fn, timeoutMs)
  }

  /** 在页面里按 predicate 表达式找元素，滚动到视口中央并返回中心坐标与描述。 */
  async findElementInfo(predicate) {
    return this.evaluate(`(() => {
      const el = (${predicate});
      if (!el) return null;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        w: r.width,
        h: r.height,
        tag: el.tagName.toLowerCase(),
        ariaLabel: el.getAttribute('aria-label'),
        ariaCurrent: el.getAttribute('aria-current'),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
        cls: String(el.className || '').slice(0, 120),
      };
    })()`)
  }

  async waitElement(desc, predicate, timeoutMs = 15000) {
    return waitUntil(desc, () => this.findElementInfo(predicate), timeoutMs)
  }

  /** 真实鼠标事件点击（mouseMoved → mousePressed → mouseReleased），坐标取元素 rect 中心。 */
  async clickInfo(info) {
    const { x, y } = info
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  async clickPredicate(desc, predicate, timeoutMs = 15000) {
    const info = await this.waitElement(desc, predicate, timeoutMs)
    await this.clickInfo(info)
    return info
  }

  /** 把鼠标移到中栏空白区，避免 tooltip 出现在截图里。 */
  async moveAway() {
    try {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(this.viewport.width / 2),
        y: Math.round(this.viewport.height * 0.78),
        button: 'none',
        buttons: 0,
      })
    } catch {
      /* ignore */
    }
  }

  async capture(name, outDir) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    const file = join(outDir, name)
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  async scan() {
    return this.evaluate(SCAN_EXPR)
  }
}

// ---------------------------------------------------------------------------
// 页面内元素 predicate（宿主 DOM 契约，见文件头注释）
// ---------------------------------------------------------------------------

const P_HUABU_ROW = `(document.querySelector('nav[aria-label="全局面板"] button[aria-label="Huabu"]') || document.querySelector('button[aria-label="Huabu"]'))`

const P_HUABU_ROW_SELECTOR = `(() => {
  const a = 'nav[aria-label="全局面板"] button[aria-label="Huabu"]';
  const b = 'button[aria-label="Huabu"]';
  return document.querySelector(a) ? a : (document.querySelector(b) ? b : null);
})()`

const P_SIDEBAR_TOGGLE_OPEN = `(() => {
  const els = Array.from(document.querySelectorAll('button,[role="button"]'));
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return els.find((e) => visible(e) && ['打开侧边栏', 'Open sidebar'].includes(e.getAttribute('aria-label'))) || null;
})()`

const P_SETTINGS_TRIGGER = `(() => {
  const els = Array.from(document.querySelectorAll('button,[role="button"]'));
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return els.find((e) => visible(e) && ['设置', 'Settings'].includes(e.getAttribute('aria-label')))
    || els.find((e) => visible(e) && e.getAttribute('aria-haspopup') === 'dialog')
    || null;
})()`

// 本 profile 的实际设置入口：账号菜单（settings.launcher 被 settings-account 接管）
const P_ACCOUNT_MENU_TRIGGER = `(() => {
  const els = Array.from(document.querySelectorAll('button,[role="button"]'));
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const byLabel = els.find((e) => visible(e) && ['账号菜单', 'Account menu'].includes(e.getAttribute('aria-label')));
  if (byLabel) return byLabel;
  // 兜底：侧栏底部的 aria-haspopup="menu" 按钮
  return els.find((e) => visible(e) && e.getAttribute('aria-haspopup') === 'menu' && e.getBoundingClientRect().y > innerHeight * 0.7) || null;
})()`

const P_SETTINGS_MENU_ITEM = `(() => {
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(visible);
  const roots = menus.length > 0 ? menus : [document.body];
  for (const root of roots) {
    const els = Array.from(root.querySelectorAll('[role="menuitem"],[role="option"],button,[role="button"]'));
    const hit = els.find((e) => {
      if (!visible(e)) return false;
      // 菜单项文本形如 "设置Ctrl+Alt+,"（label 后紧跟快捷键文本，中间无空格）
      const t = (e.textContent || '').replace(/\\s+/g, ' ').trim();
      return t === '设置' || t === 'Settings' || t.startsWith('设置') || t.startsWith('Settings');
    });
    if (hit) return hit;
  }
  return null;
})()`

const P_DIALOG = `(() => {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => {
    const r = d.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  return dialogs[dialogs.length - 1] || null;
})()`

const P_SETTINGS_NAV_HUABU = `(() => {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => {
    const r = d.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const dlg = dialogs[dialogs.length - 1];
  if (!dlg) return null;
  const btns = Array.from(dlg.querySelectorAll('button,[role="button"]'));
  return btns.find((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim() === 'Huabu') || null;
})()`

const P_PANEL = `document.querySelector('[data-huabu-panel="huabu"]')`
const P_PANEL_VISIBLE = `(() => {
  const el = document.querySelector('[data-huabu-panel="huabu"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
})()`
const P_PANEL_BACK = `(document.querySelector('[data-huabu-panel="huabu"] button.huabu-panel-back') || document.querySelector('[data-huabu-panel="huabu"] button'))`
const P_SETTINGS_SECTION_VISIBLE = `(() => {
  const el = document.querySelector('[data-huabu-settings="huabu"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
})()`

// ---------------------------------------------------------------------------
// 启动 / 导航
// ---------------------------------------------------------------------------

async function bootPage(page, opts) {
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Log.enable')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: opts.width,
    height: opts.height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await page.send('Page.navigate', { url: opts.url })

  // token 登录 + SPA 首屏渲染：等侧栏 Huabu 行真正可见
  await page.waitUntil(
    '应用启动（侧栏出现 aria-label="Huabu" 的按钮）',
    () => page.evaluate(`(() => {
      const el = document.querySelector('button[aria-label="Huabu"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`),
    opts.timeout,
  )
  // 宽态侧栏守卫：<1024px 或用户手动收起时侧栏是 56px rail，点展开按钮还原
  const rowRect = await page.evaluate(`(() => {
    const el = document.querySelector('button[aria-label="Huabu"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  })()`)
  if (rowRect && rowRect.w > 0 && rowRect.w < 100) {
    const toggle = await page.findElementInfo(P_SIDEBAR_TOGGLE_OPEN)
    if (toggle) {
      await page.clickInfo(toggle)
      await delay(500)
    }
  }
  // 等首屏稳定（字体/样式/WS 连接）
  await delay(800)

  // 全新临时 profile 首屏会连续弹「预览版说明」→「开始使用」（登录/API Key）等
  // role=dialog 的一次性引导，不关掉会挡住真实鼠标点击。先逐个关掉。
  const dismissedDialogs = await dismissBlockingDialogs(page)
  if (dismissedDialogs.length > 0) {
    await delay(600)
  }
  return { dismissedDialogs }
}

/**
 * 关闭首屏一次性引导 dialog（预览版说明 / 开始使用 / 登录引导等）。
 * 优先点「继续/关闭」类按钮，没有可点按钮时用 Escape 兜底。
 * 只在启动阶段调用，因此不会误关后续测试要用的设置面板。
 */
async function dismissBlockingDialogs(page) {
  const dismissed = []
  for (let attempt = 0; attempt < 6; attempt++) {
    const info = await page.evaluate(`(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
      const dlg = dialogs[dialogs.length - 1];
      if (!dlg) return null;
      const label = dlg.getAttribute('aria-label') || '';
      const btns = Array.from(dlg.querySelectorAll('button,[role="button"]')).filter(visible);
      const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
      const okTexts = ['继续', 'Continue', '知道了', 'Got it', '开始使用', '确认'];
      const closeLabels = ['关闭', 'Close'];
      const target =
        btns.find((b) => okTexts.includes(text(b))) ||
        btns.find((b) => closeLabels.includes(b.getAttribute('aria-label') || '') || closeLabels.includes(text(b))) ||
        null;
      if (!target) return { dismissed: false, ariaLabel: label, text: (dlg.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) };
      target.setAttribute('data-ui-probe-onboarding', '1');
      return { dismissed: true, ariaLabel: label, buttonText: text(target), buttonAria: target.getAttribute('aria-label') };
    })()`)
    if (!info) return dismissed
    if (info.dismissed) {
      const btn = await page.findElementInfo(`document.querySelector('[data-ui-probe-onboarding="1"]')`).catch(() => null)
      if (btn) await page.clickInfo(btn)
      await page.evaluate(`document.querySelector('[data-ui-probe-onboarding="1"]')?.removeAttribute('data-ui-probe-onboarding')`).catch(() => {})
      dismissed.push({ ariaLabel: info.ariaLabel, action: 'click', button: info.buttonText || info.buttonAria })
      await delay(700)
      continue
    }
    // 没有可点按钮：Escape 兜底
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    dismissed.push({ ariaLabel: info.ariaLabel, action: 'escape', text: info.text })
    await delay(700)
  }
  return dismissed
}

/**
 * 打开设置面板。兼容两套宿主实现：
 *  1) 直接存在 aria-label="设置"/"Settings" 的触发按钮（settings-general 的默认 launcher）；
 *  2) 本 profile 实际：settings.launcher 被 settings-account 接管 → 账号菜单 → menuitem「设置」。
 */
async function openSettings(page) {
  // 路径 1：直接触发按钮
  const direct = await page.findElementInfo(P_SETTINGS_TRIGGER).catch(() => null)
  if (direct) {
    await page.clickInfo(direct)
    const dlg = await page.findElementInfo(P_DIALOG).catch(() => null)
    if (dlg) return { via: 'direct-trigger', trigger: direct, dialog: dlg }
    // 点完没出现 dialog（可能是菜单型 launcher），继续走路径 2
  }

  // 路径 2：账号菜单 → 「设置」菜单项
  const accountTrigger = await page.waitElement('侧栏底部账号菜单按钮', P_ACCOUNT_MENU_TRIGGER, 10000)
  await page.clickInfo(accountTrigger)
  const menu = await page.scan().catch(() => null)
  const menuItem = await page.waitElement('账号菜单中的「设置」菜单项', P_SETTINGS_MENU_ITEM, 8000)
  await page.clickInfo(menuItem)
  const dialog = await page.waitElement('设置面板 role=dialog', P_DIALOG, 12000)
  return { via: 'account-menu', trigger: accountTrigger, menuItem, menu, dialog }
}

// ---------------------------------------------------------------------------
// 模式一：--dump
// ---------------------------------------------------------------------------

async function collectDialogButtons(page) {
  return page.evaluate(`(() => {
    const dlg = (${P_DIALOG});
    if (!dlg) return null;
    const desc = (el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
        ariaLabel: el.getAttribute('aria-label'),
        ariaCurrent: el.getAttribute('aria-current'),
        cls: String(el.className || '').slice(0, 120),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    };
    const nav = dlg.querySelector('nav');
    return {
      role: dlg.getAttribute('role'),
      ariaLabel: dlg.getAttribute('aria-label'),
      ariaLabelledby: dlg.getAttribute('aria-labelledby'),
      navAriaLabel: nav ? nav.getAttribute('aria-label') : null,
      navButtons: nav ? Array.from(nav.querySelectorAll('button,[role="button"]')).map(desc) : [],
      allButtons: Array.from(dlg.querySelectorAll('button,[role="button"]')).map(desc).slice(0, 80),
      text: (dlg.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
    };
  })()`)
}

async function runDump(page, opts, outDir, ctx) {
  const dump = { mode: 'dump', url: opts.url, viewport: { width: opts.width, height: opts.height } }
  dump.page = await page.scan()

  // 侧栏 Huabu 行候选
  dump.huabuRow = await page.evaluate(`(() => {
    const desc = (el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
        ariaLabel: el.getAttribute('aria-label'),
        ariaCurrent: el.getAttribute('aria-current'),
        cls: String(el.className || '').slice(0, 120),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: r.width > 0 && r.height > 0,
      };
    };
    return Array.from(document.querySelectorAll('button[aria-label="Huabu"]')).map(desc);
  })()`)
  dump.huabuRowSelector = await page.evaluate(P_HUABU_ROW_SELECTOR)

  // 设置入口候选：直接触发按钮 / 账号菜单
  dump.settingsTriggerDirect = await page.findElementInfo(P_SETTINGS_TRIGGER).catch(() => null)
  dump.accountMenuTrigger = await page.findElementInfo(P_ACCOUNT_MENU_TRIGGER).catch(() => null)
  if (dump.accountMenuTrigger) {
    await page.clickInfo(dump.accountMenuTrigger)
    await delay(500)
    const menuScan = await page.scan()
    dump.accountMenu = { menus: menuScan.menus, settingsMenuItem: await page.findElementInfo(P_SETTINGS_MENU_ITEM).catch(() => null) }
    const item = dump.accountMenu.settingsMenuItem
    if (item) {
      await page.clickInfo(item)
    } else {
      // 已打开菜单但没找到「设置」项：按 Escape 收起
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
  }

  // 打开设置，dump modal 内导航
  try {
    await page.waitUntil('设置面板 role=dialog', () => page.findElementInfo(P_DIALOG), 8000)
    await delay(500)
    dump.settingsDialog = await collectDialogButtons(page)
    dump.settingsNavHuabu = await page.findElementInfo(P_SETTINGS_NAV_HUABU).catch(() => null)
    await page.moveAway()
    await delay(300)
    dump.screenshot = await page.capture('a5-dump.png', outDir)
    ctx.screenshots.push(dump.screenshot)
    // Escape 关闭
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await delay(400)
  } catch (err) {
    dump.settingsDialogError = err.message
  }

  writeFileSync(join(outDir, 'a5-dump.json'), JSON.stringify(dump, null, 2) + '\n')
  console.log(JSON.stringify(dump, null, 2))
  console.log(`\n[ui-probe] dump 已写入 ${join(outDir, 'a5-dump.json')}`)
  return { ok: true, dump }
}

// ---------------------------------------------------------------------------
// 模式二：--expect-error（id 错配试验）
// ---------------------------------------------------------------------------

async function runExpectError(page, opts, outDir, ctx) {
  const before = ctx.consoleEvents.length
  const rowInfo = await page.clickPredicate('侧栏 Huabu 行', P_HUABU_ROW)
  await delay(2000)
  const events = ctx.consoleEvents.slice(before)
  const haystack = events.map((e) => e.text).join('\n')
  const matched = haystack.includes(opts.expectError)

  const report = {
    mode: 'expect-error',
    expected: opts.expectError,
    matched,
    clicked: rowInfo,
    consoleEvents: events,
  }
  if (matched) {
    const file = join(outDir, 'a5-id-mismatch.txt')
    writeFileSync(
      file,
      [
        `expect-error matched: ${opts.expectError}`,
        `clicked: ${JSON.stringify(rowInfo)}`,
        `collected at: ${new Date().toISOString()}`,
        '',
        '--- full console error text ---',
        ...events.map((e) => `[${e.kind}/${e.level}] ${e.text}${e.url ? ` @ ${e.url}:${e.line ?? '?'}` : ''}`),
        '',
        haystack,
      ].join('\n'),
    )
    report.file = file
  }
  console.log(JSON.stringify(report, null, 2))
  return { ok: matched, expectError: report }
}

// ---------------------------------------------------------------------------
// 模式三：断言 + 截图
// ---------------------------------------------------------------------------

async function runProbe(page, opts, outDir, ctx) {
  const steps = []
  const screenshots = []
  const t0 = Date.now()

  const record = (step, usedSelector, detail) => steps.push({ step, ok: true, usedSelector, detail })
  const capture = async (name) => {
    await page.moveAway()
    await delay(350)
    const file = await page.capture(name, outDir)
    screenshots.push(file)
    return file
  }
  const step = async (name, usedSelector, fn) => {
    try {
      const detail = await fn()
      record(name, usedSelector, detail)
      return detail
    } catch (err) {
      steps.push({ step: name, ok: false, usedSelector, error: err.message })
      throw err
    }
  }

  try {
    // a. 侧栏出现 aria-label="Huabu" 的按钮 → a5-1-sidebar.png
    await step('a5-1-sidebar', 'nav[aria-label="全局面板"] button[aria-label="Huabu"]（fallback: button[aria-label="Huabu"]）', async () => {
      const matchedSelector = await page.evaluate(P_HUABU_ROW_SELECTOR)
      const info = await page.waitElement('侧栏 Huabu 行可见', P_HUABU_ROW)
      const screenshot = await capture('a5-1-sidebar.png')
      return { matchedSelector, ariaLabel: info.ariaLabel, text: info.text, rect: { w: Math.round(info.w), h: Math.round(info.h) }, screenshot }
    })

    // b. 点它 → 中栏 [data-huabu-panel="huabu"]，且按钮 aria-current="page" → a5-2-panel.png
    await step('a5-2-panel', 'click: button[aria-label="Huabu"] → assert: [data-huabu-panel="huabu"] + aria-current="page"', async () => {
      const clicked = await page.clickPredicate('侧栏 Huabu 行（点击）', P_HUABU_ROW)
      const panel = await page.waitElement('中栏 Huabu 面板渲染', P_PANEL_VISIBLE, 12000)
      const state = await page.waitUntil('侧栏 Huabu 行 aria-current="page"', () => page.evaluate(`(() => {
        const el = (${P_HUABU_ROW});
        if (!el) return null;
        return el.getAttribute('aria-current') === 'page' ? { ariaCurrent: 'page', text: (el.textContent || '').trim() } : null;
      })()`), 8000)
      await delay(250)
      const screenshot = await capture('a5-2-panel.png')
      return {
        clicked: { ariaLabel: clicked.ariaLabel, rect: { w: Math.round(clicked.w), h: Math.round(clicked.h) } },
        panel: { w: Math.round(panel.w), h: Math.round(panel.h) },
        ariaCurrent: state.ariaCurrent,
        screenshot,
      }
    })

    // c. 点面板内 .huabu-panel-back（返回对话）→ 面板消失
    await step('a5-3-back', 'click: [data-huabu-panel="huabu"] button.huabu-panel-back → assert: 面板消失', async () => {
      const clicked = await page.clickPredicate('面板内「返回对话」按钮', P_PANEL_BACK)
      await page.waitUntil('Huabu 面板消失', async () => {
        const present = await page.evaluate(`!!document.querySelector('[data-huabu-panel="huabu"]')`)
        return present === false
      }, 10000)
      const rowState = await page.evaluate(`(() => {
        const el = (${P_HUABU_ROW});
        return el ? el.getAttribute('aria-current') : null;
      })()`)
      return { clicked: { text: clicked.text, cls: clicked.cls }, panelGone: true, huabuRowAriaCurrent: rowState }
    })

    // d. 设置 → 左侧导航 Huabu 行 → [data-huabu-settings="huabu"] → a5-3-settings.png
    await step(
      'a5-4-settings',
      '设置入口: button[aria-label="设置"] 或 账号菜单 button[aria-label="账号菜单"] → menuitem(text="设置")；' +
        '设置面板: div[role="dialog"]；左侧导航行: dialog 内 text="Huabu" 的 button；内容区: [data-huabu-settings="huabu"]',
      async () => {
        const opened = await openSettings(page)
        await delay(400)
        const navInfo = await page.waitElement('设置左侧导航 "Huabu" 行', P_SETTINGS_NAV_HUABU, 10000)
        await page.clickInfo(navInfo)
        const section = await page.waitElement('设置内容区 [data-huabu-settings="huabu"]', P_SETTINGS_SECTION_VISIBLE, 10000)
        await delay(300)
        const screenshot = await capture('a5-3-settings.png')
        const dialog = await collectDialogButtons(page)
        return {
          via: opened.via,
          trigger: {
            ariaLabel: opened.trigger.ariaLabel,
            tag: opened.trigger.tag,
            text: opened.trigger.text,
            rect: { w: Math.round(opened.trigger.w), h: Math.round(opened.trigger.h) },
          },
          menuItem: opened.menuItem ? { text: opened.menuItem.text, tag: opened.menuItem.tag } : null,
          navRow: { text: navInfo.text, cls: navInfo.cls },
          section: { w: Math.round(section.w), h: Math.round(section.h) },
          dialogNavLabels: (dialog?.navButtons || []).map((b) => b.text).filter(Boolean),
          screenshot,
        }
      },
    )

    const stepsOk = steps.every((s) => s.ok)
    const pageInfo = await page.evaluate(`({ title: document.title, href: location.href, viewport: { w: innerWidth, h: innerHeight } })`)
    return { ok: stepsOk, steps, screenshots, pageInfo, durationMs: Date.now() - t0 }
  } catch (err) {
    // 失败时留证据：截图 + DOM 扫描
    let failureShot = null
    try {
      await page.moveAway()
      failureShot = await page.capture('a5-failure.png', outDir)
      screenshots.push(failureShot)
    } catch {
      /* ignore */
    }
    let pageScan = null
    try {
      pageScan = await page.scan()
      writeFileSync(join(outDir, 'a5-failure.json'), JSON.stringify(pageScan, null, 2) + '\n')
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      steps,
      screenshots,
      failureShot,
      pageScan,
      error: err.message,
      durationMs: Date.now() - t0,
    }
  }
}

// ---------------------------------------------------------------------------
// 模式四：--theme（A6 主题令牌）
// ---------------------------------------------------------------------------

async function runThemeProbe(page, opts, outDir, ctx) {
  const steps = []
  const screenshots = []
  const t0 = Date.now()

  const record = (step, usedSelector, detail) => steps.push({ step, ok: true, usedSelector, detail })
  const capture = async (name) => {
    await page.moveAway()
    await delay(350)
    const file = await page.capture(name, outDir)
    screenshots.push(file)
    return file
  }
  const step = async (name, usedSelector, fn) => {
    try {
      const detail = await fn()
      record(name, usedSelector, detail)
      return detail
    } catch (err) {
      steps.push({ step: name, ok: false, usedSelector, error: err.message })
      throw err
    }
  }
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg)
  }

  // 读取当前主题下的计算样式。expected.* 用临时元素解析同一令牌，
  // 断言组件颜色确实来自令牌而不是恰好相同的硬编码值。
  const READ_STYLES = `(() => {
    const resolve = (prop, token) => {
      const el = document.createElement('div');
      el.style.setProperty(prop, 'var(' + token + ')');
      document.body.appendChild(el);
      const value = getComputedStyle(el)[prop];
      el.remove();
      return value;
    };
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        color: cs.color,
        borderBottomColor: cs.borderBottomColor,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      };
    };
    const styleEl = document.getElementById('dsh-huabu-theme');
    const bodyStyle = getComputedStyle(document.body);
    return {
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      style: styleEl ? {
        id: styleEl.id,
        bytes: (styleEl.textContent || '').length,
        hasAliasToken: /--dsw-alias-bg-base/.test(styleEl.textContent || ''),
        hasPanelClass: /\\.huabu-panel\\b/.test(styleEl.textContent || ''),
      } : null,
      tokens: {
        bgBase: bodyStyle.getPropertyValue('--dsw-alias-bg-base').trim(),
        labelPrimary: bodyStyle.getPropertyValue('--dsw-alias-label-primary').trim(),
        labelSecondary: bodyStyle.getPropertyValue('--dsw-alias-label-secondary').trim(),
      },
      expected: {
        bgBase: resolve('background-color', '--dsw-alias-bg-base'),
        labelPrimary: resolve('color', '--dsw-alias-label-primary'),
        labelSecondary: resolve('color', '--dsw-alias-label-secondary'),
      },
      panel: pick('[data-huabu-panel="huabu"]'),
      header: pick('[data-huabu-panel="huabu"] .huabu-panel-header'),
      back: pick('[data-huabu-panel="huabu"] .huabu-panel-back'),
      section: pick('[data-huabu-settings="huabu"]'),
      sectionTitle: pick('[data-huabu-settings="huabu"] .huabu-settings-title'),
      sectionRow: pick('[data-huabu-settings="huabu"] .huabu-settings-row'),
    };
  })()`

  const readStyles = () => page.evaluate(READ_STYLES)
  const setDark = (on) =>
    page.evaluate(`(() => {
      if (${on}) document.body.setAttribute('data-ds-dark-theme', '');
      else document.body.removeAttribute('data-ds-dark-theme');
      return document.body.hasAttribute('data-ds-dark-theme');
    })()`)
  const settle = () =>
    page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`, {
      awaitPromise: true,
    })

  try {
    // a. 注入节点与样式内容
    await step('a6-1-style-tag', '<style id="dsh-huabu-theme"> 由 client apply 注入', async () => {
      const styles = await readStyles()
      assert(styles.style, '未找到 <style id="dsh-huabu-theme">')
      assert(styles.style.hasAliasToken, '注入样式未包含 --dsw-alias-* 令牌')
      assert(styles.style.hasPanelClass, '注入样式未包含 .huabu-panel 规则')
      return { style: styles.style }
    })

    // b. 浅色面板：背景/文字必须等于同名令牌的解析值
    let light
    await step('a6-2-panel-light', 'click 侧栏 Huabu → 面板背景=--dsw-alias-bg-base、文字=--dsw-alias-label-primary', async () => {
      await page.clickPredicate('侧栏 Huabu 行', P_HUABU_ROW)
      await page.waitElement('中栏 Huabu 面板渲染', P_PANEL_VISIBLE, 12000)
      await settle()
      light = await readStyles()
      assert(!light.dark, '初始状态不应是深色')
      assert(light.panel, '未找到 [data-huabu-panel="huabu"]')
      assert(
        light.panel.bg === light.expected.bgBase,
        `浅色面板背景 ${light.panel.bg} ≠ --dsw-alias-bg-base 解析值 ${light.expected.bgBase}`,
      )
      assert(
        light.panel.color === light.expected.labelPrimary,
        `浅色面板文字 ${light.panel.color} ≠ --dsw-alias-label-primary 解析值 ${light.expected.labelPrimary}`,
      )
      assert(
        light.header.color === light.expected.labelPrimary,
        `浅色面板标题 ${light.header.color} ≠ --dsw-alias-label-primary 解析值 ${light.expected.labelPrimary}`,
      )
      assert(
        light.back.color === light.expected.labelSecondary,
        `浅色返回按钮 ${light.back.color} ≠ --dsw-alias-label-secondary 解析值 ${light.expected.labelSecondary}`,
      )
      const screenshot = await capture('a6-1-panel-light.png')
      return { panel: light.panel, header: light.header, back: light.back, tokens: light.tokens, screenshot }
    })

    // c. 深色面板：同一组件随 body[data-ds-dark-theme] 切换
    let dark
    await step('a6-3-panel-dark', 'body[data-ds-dark-theme] → 面板背景/文字随令牌切换', async () => {
      const applied = await setDark(true)
      assert(applied, '设置 body[data-ds-dark-theme] 失败')
      await settle()
      // 按钮有 0.12s 颜色过渡，等过渡结束再取计算样式
      await delay(250)
      dark = await readStyles()
      assert(dark.dark, '深色属性未生效')
      assert(
        dark.panel.bg === dark.expected.bgBase,
        `深色面板背景 ${dark.panel.bg} ≠ --dsw-alias-bg-base 解析值 ${dark.expected.bgBase}`,
      )
      assert(
        dark.panel.color === dark.expected.labelPrimary,
        `深色面板文字 ${dark.panel.color} ≠ --dsw-alias-label-primary 解析值 ${dark.expected.labelPrimary}`,
      )
      assert(
        dark.header.color === dark.expected.labelPrimary,
        `深色面板标题 ${dark.header.color} ≠ --dsw-alias-label-primary 解析值 ${dark.expected.labelPrimary}`,
      )
      assert(
        dark.back.color === dark.expected.labelSecondary,
        `深色返回按钮 ${dark.back.color} ≠ --dsw-alias-label-secondary 解析值 ${dark.expected.labelSecondary}`,
      )
      assert(dark.panel.bg !== light.panel.bg, '深浅色面板背景未变化')
      assert(dark.panel.color !== light.panel.color, '深浅色面板文字未变化')
      const screenshot = await capture('a6-2-panel-dark.png')
      return { panel: dark.panel, header: dark.header, back: dark.back, tokens: dark.tokens, screenshot }
    })

    // d. 深色设置分区
    let settingsDark
    await step('a6-4-settings-dark', '设置 → Huabu 分区 → 正文=label-secondary、标题=label-primary（深色）', async () => {
      await page.clickPredicate('面板内「返回对话」按钮', P_PANEL_BACK)
      await page.waitUntil(
        'Huabu 面板消失',
        async () => (await page.evaluate(`!!document.querySelector('[data-huabu-panel="huabu"]')`)) === false,
        10000,
      )
      await openSettings(page)
      const navInfo = await page.waitElement('设置左侧导航 "Huabu" 行', P_SETTINGS_NAV_HUABU, 10000)
      await page.clickInfo(navInfo)
      await page.waitElement('设置内容区 [data-huabu-settings="huabu"]', P_SETTINGS_SECTION_VISIBLE, 10000)
      await settle()
      settingsDark = await readStyles()
      assert(settingsDark.dark, '打开设置后深色属性丢失')
      assert(settingsDark.section, '未找到 [data-huabu-settings="huabu"]')
      assert(settingsDark.sectionTitle && settingsDark.sectionRow, '分区内缺少 .huabu-settings-title / .huabu-settings-row')
      assert(
        settingsDark.sectionRow.color === settingsDark.expected.labelSecondary,
        `深色分区正文 ${settingsDark.sectionRow.color} ≠ --dsw-alias-label-secondary 解析值 ${settingsDark.expected.labelSecondary}`,
      )
      assert(
        settingsDark.sectionTitle.color === settingsDark.expected.labelPrimary,
        `深色分区标题 ${settingsDark.sectionTitle.color} ≠ --dsw-alias-label-primary 解析值 ${settingsDark.expected.labelPrimary}`,
      )
      const screenshot = await capture('a6-3-settings-dark.png')
      return {
        section: settingsDark.section,
        title: settingsDark.sectionTitle,
        row: settingsDark.sectionRow,
        tokens: settingsDark.tokens,
        screenshot,
      }
    })

    // e. 浅色设置分区：同一节点去掉属性后回到浅色令牌
    await step('a6-5-settings-light', '移除 body[data-ds-dark-theme] → 同一分区回到浅色令牌', async () => {
      const applied = await setDark(false)
      assert(!applied, '移除 body[data-ds-dark-theme] 失败')
      await settle()
      await delay(250)
      const settingsLight = await readStyles()
      assert(!settingsLight.dark, '浅色属性未生效')
      assert(settingsLight.sectionTitle && settingsLight.sectionRow, '分区内缺少 .huabu-settings-title / .huabu-settings-row')
      assert(
        settingsLight.sectionRow.color === settingsLight.expected.labelSecondary,
        `浅色分区正文 ${settingsLight.sectionRow.color} ≠ --dsw-alias-label-secondary 解析值 ${settingsLight.expected.labelSecondary}`,
      )
      assert(
        settingsLight.sectionTitle.color === settingsLight.expected.labelPrimary,
        `浅色分区标题 ${settingsLight.sectionTitle.color} ≠ --dsw-alias-label-primary 解析值 ${settingsLight.expected.labelPrimary}`,
      )
      assert(settingsDark.sectionRow.color !== settingsLight.sectionRow.color, '深浅色分区正文颜色未变化')
      assert(settingsDark.sectionTitle.color !== settingsLight.sectionTitle.color, '深浅色分区标题颜色未变化')
      const screenshot = await capture('a6-4-settings-light.png')
      return {
        section: settingsLight.section,
        title: settingsLight.sectionTitle,
        row: settingsLight.sectionRow,
        tokens: settingsLight.tokens,
        screenshot,
      }
    })

    const stepsOk = steps.every((s) => s.ok)
    const pageInfo = await page.evaluate(`({ title: document.title, href: location.href, viewport: { w: innerWidth, h: innerHeight } })`)
    return { ok: stepsOk, steps, screenshots, pageInfo, durationMs: Date.now() - t0 }
  } catch (err) {
    await setDark(false).catch(() => {})
    let failureShot = null
    try {
      await page.moveAway()
      failureShot = await page.capture('a6-failure.png', outDir)
      screenshots.push(failureShot)
    } catch {
      /* ignore */
    }
    let pageScan = null
    try {
      pageScan = await page.scan()
      writeFileSync(join(outDir, 'a6-failure.json'), JSON.stringify(pageScan, null, 2) + '\n')
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      steps,
      screenshots,
      failureShot,
      pageScan,
      error: err.message,
      durationMs: Date.now() - t0,
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv)
  if (!opts.url) {
    usage()
    die('--url 必填')
  }

  const outDir = resolve(opts.out)
  mkdirSync(outDir, { recursive: true })

  const startedAt = new Date()
  const t0 = Date.now()
  const ctx = { consoleEvents: [], screenshots: [] }
  let launch = null
  let cdp = null
  let page = null
  let result = null
  let fatal = null

  try {
    launch = await launchChrome(opts)
    cdp = await CDP.connect(launch.wsUrl)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    page = new Page(cdp, sessionId, opts)

    // 控制台错误收集：Runtime.exceptionThrown + Log.entryAdded(error/warning) + Runtime.consoleAPICalled
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return
      try {
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails || {}
          const ex = d.exception || {}
          ctx.consoleEvents.push({
            kind: 'exception',
            level: 'error',
            text: ex.description || d.text || 'unknown exception',
            url: d.url,
            line: d.lineNumber,
            column: d.columnNumber,
          })
        } else if (msg.method === 'Log.entryAdded') {
          const e = msg.params.entry || {}
          if (e.level === 'error' || e.level === 'warning') {
            ctx.consoleEvents.push({
              kind: 'log',
              level: e.level,
              text: e.text || '',
              source: e.source,
              url: e.url,
              line: e.lineNumber,
            })
          }
        } else if (msg.method === 'Runtime.consoleAPICalled') {
          const type = msg.params.type
          if (type === 'error' || type === 'warning') {
            const args = (msg.params.args || []).map((a) => {
              if (!a) return ''
              if (Object.prototype.hasOwnProperty.call(a, 'value')) return String(a.value)
              if (a.unserializableValue) return a.unserializableValue
              return a.description ?? a.type ?? ''
            })
            ctx.consoleEvents.push({
              kind: 'console',
              level: type,
              text: args.join(' '),
              url: msg.params.stackTrace?.callFrames?.[0]?.url,
              line: msg.params.stackTrace?.callFrames?.[0]?.lineNumber,
            })
          }
        }
      } catch {
        /* ignore malformed event */
      }
    })

    const bootInfo = await bootPage(page, opts)
    ctx.bootInfo = bootInfo

    if (opts.dump) {
      result = await runDump(page, opts, outDir, ctx)
    } else if (opts.expectError) {
      result = await runExpectError(page, opts, outDir, ctx)
    } else if (opts.theme) {
      result = await runThemeProbe(page, opts, outDir, ctx)
    } else {
      result = await runProbe(page, opts, outDir, ctx)
    }
  } catch (err) {
    fatal = err
    // 启动/导航阶段失败：尽量留失败截图
    if (page) {
      try {
        const file = await page.capture('a5-failure.png', outDir)
        ctx.screenshots.push(file)
      } catch {
        /* ignore */
      }
    }
  } finally {
    const summary = {
      tool: TOOL,
      version: VERSION,
      ok: false,
      mode: opts.dump ? 'dump' : opts.expectError ? 'expect-error' : opts.theme ? 'theme' : 'probe',
      url: opts.url,
      chrome: launch?.chromePath ?? null,
      viewport: { width: opts.width, height: opts.height, deviceScaleFactor: 1 },
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - t0,
      boot: ctx.bootInfo ?? null,
      ...(result || {}),
      consoleEvents: ctx.consoleEvents,
      consoleErrors: ctx.consoleEvents.filter((e) => e.level === 'error'),
      consoleWarnings: ctx.consoleEvents.filter((e) => e.level === 'warning'),
      screenshots: ctx.screenshots.length > 0 ? ctx.screenshots : result?.screenshots ?? [],
      ...(fatal ? { fatal: fatal.message } : {}),
    }
    summary.ok = Boolean(result?.ok) && !fatal

    // dump 模式的完整数据已写 a5-dump.json；这里统一落一份摘要便于读取
    const reportName = opts.theme ? 'a6-probe.json' : 'a5-probe.json'
    writeFileSync(join(outDir, reportName), JSON.stringify(summary, null, 2) + '\n')

    console.log(JSON.stringify(summary, null, 2))

    if (fatal) {
      console.error(`\n[ui-probe] FATAL: ${fatal.message}`)
      if (launch) {
        const stderrTail = launch.getStderr().slice(-1500)
        if (stderrTail.trim()) console.error(`--- chrome stderr tail ---\n${stderrTail}`)
      }
    } else if (opts.expectError) {
      if (!result?.ok) console.error(`\n[ui-probe] --expect-error "${opts.expectError}" 未命中（exit 2）`)
    } else if (opts.theme) {
      const failed = (result?.steps || []).filter((s) => !s.ok)
      if (failed.length > 0) {
        console.error(`\n[ui-probe] A6 断言失败 ${failed.length} 项：`)
        for (const s of failed) console.error(`  - ${s.step}: ${s.error}`)
      } else {
        console.error('\n[ui-probe] 5 项 A6 主题断言全部通过。')
      }
      if (summary.consoleErrors.length > 0) {
        console.error(`[ui-probe] 注意：收集到 ${summary.consoleErrors.length} 条控制台 error（详见 a6-probe.json consoleErrors）。`)
      }
    } else if (!opts.dump) {
      const failed = (result?.steps || []).filter((s) => !s.ok)
      if (failed.length > 0) {
        console.error(`\n[ui-probe] 断言失败 ${failed.length} 项：`)
        for (const s of failed) console.error(`  - ${s.step}: ${s.error}`)
      } else {
        console.error('\n[ui-probe] 4 项 A5 断言全部通过。')
      }
      if (summary.consoleErrors.length > 0) {
        console.error(`[ui-probe] 注意：收集到 ${summary.consoleErrors.length} 条控制台 error（详见 a5-probe.json consoleErrors）。`)
      }
    }

    if (cdp) cdp.close()
    cleanupChrome(launch, opts.keepTemp)

    let exitCode = 0
    if (fatal) exitCode = 1
    else if (opts.expectError) exitCode = result?.ok ? 0 : 2
    else if (opts.dump) exitCode = 0
    else if (!result?.ok) exitCode = 1
    else if (opts.strictConsole && summary.consoleErrors.length > 0) exitCode = 3

    process.exit(exitCode)
  }
}

main().catch((err) => {
  console.error(`[ui-probe] unexpected: ${err?.stack || err}`)
  process.exit(1)
})