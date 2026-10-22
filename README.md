# dsh-huabu

Huabu 的外层能力层，打包为 DeepSeek Harness (DSH) 插件：
**媒体生成**（图片/视频/音频）、**素材库**、**blockout 粗模运镜预演**、**视频理解**（抽帧精读）。

- 一个 npm 包同时是 DSH bundle + host 插件 + client 插件（`main` → `lib/index.js`，client → `lib/client.js`）。
- 状态契约沿用 Huabu 桌面应用的 `.huabu/` 与 `assets/` 布局：**工作区 = DSH 会话 cwd**，现有项目开箱可用。
- 适配 DSH `>=0.2.0-rc.1 <0.3.0-0`（`engines.dsh`）；Cordis `~4.0.5`。
- 本仓库独立于主应用仓库；主仓库源码（`../src`）仅作能力参考。blockout 引擎已原样入库 `src/blockout/`，构建只读本仓，不依赖主仓库检出；与上游的漂移由 sha256 清单校验。

> 状态：阶段 A（骨架/导航/样式）完成，阶段 B（blockout 端到端）完成（B6 待确认）。
> 完整的能力说明、权限（出网主机清单）与已知限制在发布前（G3）补齐。

## 开发

```bash
pnpm install    # 本目录独立安装（自己的 lockfile）
pnpm build      # 产出 lib/index.js、lib/client.js、lib/blockout/
pnpm typecheck
pnpm test:blockout  # 引擎黄金夹具（53 项）
pnpm test:service   # blockout 服务单测（子进程/超时/取消/进度）
pnpm test:tool      # huabu_blockout 工具单测（参数/路径安全带/文本结果/发布/回喂）
pnpm test:skills    # 技能安装单测（版本戳/幂等/缺失修复）
pnpm test:card      # BlockoutCard 解析单测（header/JSON/动作/指标格式）
pnpm check:drift    # src/blockout 与 sha256 清单 / 上游的一致性
```

## 安装到 DSH（web profile，开发验证用）

```powershell
dsh plugin --profile web add link:<本目录绝对路径>
```