---
name: huabu-media
description: Huabu 媒体生成工具使用纪律：图片/视频/音频生成的模型选择、比例与时长参数、参考素材角色语义、视频确认闸门、产物命名与归档约定、成本控制。要生成图片/视频/音频时先读这份。
metadata:
  huabuVersion: 0.1.0
---

# Huabu 媒体生成（dsh-huabu 插件）

工具：`huabu_image_generate`（图片，同步）；视频/音频工具在后续版本接入。
所有产物自动归档进素材库（`assets/<分类>/`），可用 `huabu_asset_list` 查、`huabu_asset_tag` 打标。

## 1. 供应商与模型

- **默认供应商 = `mock`（零成本本地占位图）**：适合验证流程、占位、构图草稿。它不联网、出的是程序生成的渐变 PNG——**不要把它当真实设计产出交付**。
- 真实出图需要供应商 API Key（环境变量）：`DASHSCOPE_KEY`（阿里百炼）、`ARK_KEY`（火山方舟）、`MINIMAX_KEY`、`TENCENT_KEY`（腾讯混元）、`OPENAI_KEY`。
- 切换默认供应商：workspace.json 的 `media.agentProvider`（如 `"dashscope"`）；指定模型用 `media.agentModels.image = "dashscope/wan2.7-image"` 这类 `供应商/模型` 记法。
- 模型能力（支持的比例/时长档位/垫图上限）由清单声明，传不支持的参数会被工具直接拒绝并给出支持列表。

## 2. 图片生成纪律（huabu_image_generate）

1. **prompt 要具体**：主体 + 风格 + 构图 + 光线。一句话只写主体是浪费一次生成。
2. **比例按用途选**：主视觉 16:9 / 社媒竖图 9:16 / 头像与图标 1:1 / 海报 3:4。不确定就 16:9。
3. **垫图（reference_images）**：给工作区相对路径（素材库里的图直接引用 `assets/images/...`）；以参考图为底做变体时用，条数上限由模型决定。
4. **命名（name）**：给业务语义名（`hero-banner`、`icon-home`），产物落 `assets/images/<name>.png`；不给则用随机 id，回头很难对上。
5. 同名不覆盖：目录里已有同名文件会自动加 `-2` 序号。
6. 生成是同步等待（几十秒）；一次改一个变量迭代，不要一口气连发多张。

## 3. 视频生成纪律（后续版本）

- 视频成本高（按秒计费）：**必须先向用户确认，用户同意后才带 `confirmed: true` 调用**。
- 参考素材按角色分槽：`first_frame` / `last_frame`（首尾帧图生视频）、`reference_images` / `reference_videos` / `reference_audios`（全模态参考）。混用首帧与 reference_* 会报错。
- 时长选最短够用的档位；先用 blockout 粗模验证运镜再花钱出真片。

## 4. 产物约定

- 生成产物默认归档进 `assets/images/`（可被 workspace.json `media.defaultLibraryId` 改）。
- 迭代版本用 name 后缀区分（`hero-v2`），不要覆盖式命名后抱怨找不回旧版。
- 需要当参考图的产物直接引用其归档路径；需要整理时用 `huabu_asset_tag` 打标签。

## 5. 成本与失败处理

- 真实供应商每次生成都花钱：mock 免费、图便宜、视频贵。拿不准先用 mock 走流程。
- 失败分类处理：凭据类（401/403）→ 让用户检查 Key，不要再试；参数类（比例/时长不支持）→ 按错误里的支持列表改；超时/临时错误 → 可重试一次。
- 连续失败两次仍无新信息 → 停下来向用户说明，不要循环重试。