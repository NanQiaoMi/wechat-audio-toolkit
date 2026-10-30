# 音频格式转换小程序

在微信里完成音频格式转换：从微信聊天导入音频 → 选择目标格式与音质 → 云端转码 → 试听 / 转发好友 / PC 保存。

> 当前阶段（2026-10-28）：个人主体、云开发环境已开通（`cloud1-d0g1pwjogd2f39be2`）；路线 A（云函数 + 静态 FFmpeg 7.0.2）**有条件通过**，转换主链路原型可端到端（真实 5min 音频 15.1s）；额度/24h 清理/隐私弹窗/设置页已验证。**待办：备案与隐私指引配置、类目提交、真机全流程、正式函数命名**。并已将 **「音乐剪辑」MVP v2 与「格式转换」合并为同一个小程序的双 tab 入口**（`pages/index` / `pages/editor`）：支持多选导入（≤5 个音频）→片段时间线（上移/下移/分割/裁剪/删除/撤销）→每片段独立淡入淡出→跨源预览→导出 MP3→试听/转发；详细设计与实现偏差见 [docs/MUSIC_EDITOR_DESIGN.md](./docs/MUSIC_EDITOR_DESIGN.md)。
> 三个关键约束：小程序不能读取手机本地文件；iOS 不能直接试听 flac/ogg/amr/ape/wma；手机端不能把音频保存到系统目录。

## 文档

| 文档 | 说明 |
| :--- | :--- |
| [docs/README.md](./docs/README.md) | 文档索引与阅读顺序 |
| [docs/FEASIBILITY.md](./docs/FEASIBILITY.md) | 可行性研究（官方来源核实、限制、合规） |
| [docs/TASK_PLAN.md](./docs/TASK_PLAN.md) | 任务计划与技术方案（架构、WBS、排期、风险） |
| [docs/PRD.md](./docs/PRD.md) | 产品需求文档（功能、页面、流程、验收） |
| [docs/DEV_LOG.md](./docs/DEV_LOG.md) | 开发记录（ADR、进度、问题、模板） |
| [docs/MUSIC_EDITOR_DESIGN.md](./docs/MUSIC_EDITOR_DESIGN.md) | **在线音乐编辑详细设计 + 音乐剪辑 MVP 实现记录** |

## 技术路线（A/B 验证中）

- 客户端固定：原生小程序；基础库 ≥2.23.0；异步任务（申请上传票据 → 直传 → 建任务 → 轮询），避免 `callContainer` 15s 超时。
- **路线 A（优先验证，免费环境）**：云开发云函数 + 精简 FFmpeg + 云存储/云数据库；若 50MB/30min 与超时满足，则**不需要云托管**。
- **路线 B（兜底）**：微信云托管 Docker + FFmpeg + 对象存储；A 不通过时启用。
- 两条路线客户端接口一致，服务端实现可替换；内容安全 `mediaCheckAsync` + 消息推送回调；24h 清理。

## 目录规划

```text
miniprogram/      小程序端（页面/组件/工具）
server/           云托管服务（Dockerfile + Express + Worker + FFmpeg）
cloudfunctions/   现有 quickstart 示例，M3 清理
docs/             文档（本目录）
scripts/          本地验证脚本
samples/          测试音频（大文件不入库）
```

## 快速开始

1. 用微信开发者工具打开本目录（`project.config.json` 已指向 `miniprogram/`）。
2. 云开发环境已开通并写入 `miniprogram/envList.js`/`app.js`；在开发者工具「设置 → 安全设置」开启「服务端口」后，即可部署 `cloudfunctions/ffmpegProbe` 做路线 A 验证；若 A 失败再开通微信云托管（管理员扫码）。
3. 启动 Docker Desktop 后，本地验证 FFmpeg：`docker run --rm linuxserver/ffmpeg -version`（本机 Docker 28.3 已可用；云函数内静态 FFmpeg 已部署验证）。
4. 按 [TASK_PLAN §4.0](./docs/TASK_PLAN.md) 的技术路线验证门与 [DEV_LOG §6](./docs/DEV_LOG.md) 的 Spike 清单先验证；V1.1 编辑功能按 [MUSIC_EDITOR_DESIGN](./docs/MUSIC_EDITOR_DESIGN.md) §13 的 Spike 先行。

## 已确认 / 待确认

- **已确认（2026-10-27）**：个人主体；公开发布；免费（无广告/无付费）；云开发环境 `cloud1-d0g1pwjogd2f39be2`；单文件 50MB / 30 分钟；保留“转发给好友”；接受“先转换、并行送检、命中后删除”。
- **待确认/待办**：备案材料（11-02 前）、隐私指引后台配置并恢复 `__usePrivacyCheck__`、类目提交、真机全流程；V1.1 编辑设计的 3 个产品决策（进 v1.1 还是 v1.0、额度共享、格式/时长矩阵）待拍板，见 [MUSIC_EDITOR_DESIGN §17](./docs/MUSIC_EDITOR_DESIGN.md)。
- 详见 [TASK_PLAN §14](./docs/TASK_PLAN.md) 与 [PRD §16](./docs/PRD.md)。

## 发布合规

- [发布前检查清单](docs/RELEASE_CHECKLIST.md)
- [隐私政策](docs/legal/PRIVACY_POLICY.md) · [用户协议](docs/legal/USER_AGREEMENT.md) · [版权投诉指引](docs/legal/COPYRIGHT_COMPLAINT.md)
