# dsh-huabu

Huabu 的外层能力层，打包为 DeepSeek Harness (DSH) 插件：
**媒体生成**（图片/视频/音频）、**素材库**、**blockout 粗模运镜预演**、**视频理解**（抽帧精读）。

- 一个 npm 包同时是 DSH bundle + host 插件 + client 插件（`main` → `lib/index.js`，client → `lib/client.js`）。
- 状态契约沿用 Huabu 桌面应用的 `.huabu/` 与 `assets/` 布局：**工作区 = DSH 会话 cwd**，现有项目开箱可用。
- 适配 DSH `>=0.2.0-rc.1 <0.3.0-0`（`engines.dsh`）；Cordis `~4.0.5`。
- 本仓库独立于主应用仓库；媒体引擎（`src/media/`）与 blockout 引擎（`src/blockout/`）已入库本仓，构建只读本仓；blockout 与上游的漂移由 sha256 清单校验（媒体层为带偏差注释的移植：mock 供应商、超时注入口等，见文件头注释）。

## 能力（v0.1.0）

| 工具 | 说明 |
|---|---|
| `huabu_image_generate` | 文生图/垫图，产物归档 `assets/images/`，图片随结果回喂 |
| `huabu_video_generate` | 视频生成：**确认闸门**（`confirmed`）→ 宿主 jobs 后台任务（不阻塞会话，完成自动唤醒） |
| `huabu_audio_generate` | 音频生成，同走 jobs |
| `huabu_video_skim` | 视频粗扫：6 帧 + 时长/分辨率/帧率，帧图回喂 |
| `huabu_video_frames` | 区间精读（≤8 帧、区间 ≤300s、`.huabu/vframes` 缓存） |
| `huabu_asset_list` / `huabu_asset_import` / `huabu_asset_tag` | 素材库清单/归档/标签（`assets/` 分类 + 命名库 + `.huabu/tags.json`，与桌面 App 数据同源） |
| `huabu_context` | 项目态势：素材摘要 + 画布状态 + 生成任务（含重启中断对账） |
| `huabu_blockout` | 粗模/运镜引擎 7 动作（check/describe/sheet/view/shot/shots/video），拼版/关键帧回喂 |
| （自动） | 每轮系统摘要注入（素材态势 ≤300 token，未变化为空）；技能 `huabu-blockout` / `huabu-media` 幂等安装 |

**默认供应商 = `mock`（本地零成本）**：图片渐变 PNG、视频 ffmpeg 测试图、音频合成 WAV——不联网、全链路可验证，但不是真实创作产出。真实生成需配供应商 Key 并把 `workspace.json` 的 `media.agentProvider` 指过去。

## 配置

- **供应商凭据**：环境变量（`DASHSCOPE_KEY` / `ARK_KEY` / `MINIMAX_KEY` / `TENCENT_KEY` / `OPENAI_KEY`）或插件配置 `media.apiKeys`（profile 的 cordis.patch.yml，按 id）。插件不落明文 Key 到项目文件。
- **项目级**（`workspace.json` 的 `media` 段，与 App 同构）：`agentProvider` / `agentModels`（默认生成模型）、`confirmVideo`（视频确认闸门，默认开）、`outputDir` / `defaultLibraryId` / `kindLibraryDefaults`（产物落库）、`userProviders`（自建网关）。
- **插件级**：`installSkills`（默认 true）、`injectDigest` / `digestBudgetTokens` / `digestMinIntervalMs`（每轮摘要）、`media.ffmpegPath`（ffmpeg 显式路径；缺省探测 env `FFMPEG_PATH`/`FFMPEG` → `ffmpeg-static` → PATH）。

## 权限（出网主机白名单）

```
https://dashscope.aliyuncs.com   https://ark.cn-beijing.volces.com
https://open.volcengineapi.com   https://api.minimaxi.com
https://hunyuan.tencentcloudapi.com  https://api.openai.com
https://fal.run                  https://queue.fal.run
```

仅媒体生成网关；`mock` 供应商与 blockout/视频理解均纯本地。

## 已知限制（v0.1.0）

- 真实供应商链路（五家网关适配器为移植代码 + mock fetch 单测）**未用真实 Key 做过线上验证**；配 Key 后如遇协议漂移请提 issue。
- 摘要注入的 cwd 缓存经异步预热：会话第一轮 system prompt 可能还没有摘要（下一轮起可用）。
- `huabu_video_skim/frames` 无专属卡片（帧图模型可见、generic 卡不渲图，人工看图走产物目录）；v0.1.x 可选升级。
- 视频确认闸门是对话式（模型转述），未接宿主审批弹窗；`accessMode=confirm` 全量确认未实装。
- workspace.json 无文件锁（App 与插件不同时用同一工作区；v0.2 加锁）。
- 技能装到 `$DSH_HOME/skills`，同 DSH_HOME 的其他 profile 也会看到。

## 开发

```bash
pnpm install    # 本目录独立安装（自己的 lockfile）
pnpm build      # 产出 lib/index.js、lib/client.js、lib/blockout/
pnpm typecheck
pnpm test:all   # 一键门禁：typecheck + build + 引擎自检 + 漂移 + 全部单测 + 体积守卫
# 分项（test:all 内含全部）：
pnpm test:blockout  # 引擎黄金夹具（53 项）
pnpm test:service   # blockout 服务单测（子进程/超时/取消/进度）
pnpm test:tool      # huabu_blockout 工具单测（参数/路径安全带/文本结果/发布/回喂）
pnpm test:skills    # 技能安装单测（版本戳/幂等/缺失修复）
pnpm test:card      # BlockoutCard 解析单测（header/JSON/动作/指标格式）
pnpm test:project   # huabu.project 单测（workspace.json/路径白名单/apply 注册）
pnpm test:assets    # huabu.assets 单测（分类表/归档/命名库/标签索引/搜索）
pnpm test:asset-tools # 素材工具三件套 + huabu_context + 摘要注入单测
pnpm test:media     # huabu.media 单测（目录校验/合并层/mock 端到端/对账/失败路径）
pnpm test:image     # huabu_image_generate 单测（参数/回退链/落库/回喂/卡片解析）
pnpm test:video     # 视频/音频生成单测（闸门/jobs/配额/卡片解析）
pnpm test:vision    # 视频理解单测（ffmpeg 探测链/skim/frames/缓存）
pnpm check:drift    # src/blockout 与 sha256 清单 / 上游的一致性
```

测试需要 PATH 可见的 ffmpeg（视频理解与 mock 视频用；Windows `winget install ffmpeg` 即可）。

## 安装到 DSH

**从 GitHub Release 安装（推荐）**——每个版本附带 npm 打包的 tarball：

```powershell
# 指定版本
dsh plugin --profile <profile> add https://github.com/acefun29/dsh-huabu/releases/download/v0.1.0/dsh-huabu-0.1.0.tgz
# 或始终跟最新版（资产名带版本号，latest 短链需先到 Releases 页查看文件名）
```

> 注：DSH 内置 pnpm v11 对含安装脚本的依赖（ffmpeg-static）会提示 `pnpm approve-builds` 并以非零码结束——插件本体已正常装入，忽略即可；ffmpeg 走 PATH 探测不受影响。

**开发调试（本地目录直连）**：

```powershell
dsh plugin --profile <profile> add link:<本目录绝对路径>
```

发布流程：打 tag `v*` 推送 → GitHub Actions 跑全部门禁 → 自动建 Release 并附 `dsh-huabu-<版本>.tgz`。
