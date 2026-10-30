# 文档索引（docs）

> 项目：微信小程序「音频格式转换」 · 最后更新：2026-10-28

## 阅读顺序

1. [可行性研究](./FEASIBILITY.md) — 官方文档核实过的能力边界、限制、合规结论（424 行，69 个来源）。
2. [任务计划与技术方案](./TASK_PLAN.md) — 架构、功能规划、WBS、里程碑、成本、风险、开放问题。
3. [产品需求文档](./PRD.md) — 用户、场景、功能需求（FR）、页面、流程、验收标准。
4. [开发记录](./DEV_LOG.md) — 本次工作记录、ADR、问题、Spike 清单、模板。
5. **[在线音乐编辑详细设计](./MUSIC_EDITOR_DESIGN.md)** — 编辑模型/数据契约、客户端波形与预览、服务端 FFmpeg 管线、接口/限额/测试/验收；§19 记录 2026-10-28 MVP 落地与偏差。
6. [发布前检查清单](./RELEASE_CHECKLIST.md) — 提审/备案/上线逐项确认。
7. [法律与合规文本](./legal/) — 隐私政策、用户协议、版权投诉指引草稿。

> 编辑设计的支撑材料在 [`research/`](./research/)：客户端能力核验（CLIENT_CAPABILITIES）、FFmpeg 剪辑实测（FFMPEG_EDIT_SPIKE）、UX 交互规格与 SVG 线框（UX_EDITOR_SPEC + ux/）。

## 文档清单

| 文件 | 内容 | 状态 |
| :--- | :--- | :--- |
| [FEASIBILITY.md](./FEASIBILITY.md) | 端内/云端可行性、API 限制、格式矩阵、合规依据 | ✅ v1 |
| [TASK_PLAN.md](./TASK_PLAN.md) | 技术方案、详细功能规划、WBS、排期、风险 | ✅ v2.5（含 V1.1 编辑里程碑） |
| [PRD.md](./PRD.md) | 产品需求、交互、验收、合规 | ✅ v1.3（含 V1.1 编辑 FR 摘要） |
| [DEV_LOG.md](./DEV_LOG.md) | 决策记录、进度、问题、测试/发布模板 | ✅ v1.6（2026-10-28） |
| [MUSIC_EDITOR_DESIGN.md](./MUSIC_EDITOR_DESIGN.md) | 在线音乐编辑详细设计 + MVP v2 实现记录 | ✅ v0.2 评审修订；MVP v2 已落地（§19，多片段/每片 fade） |
| [research/](./research/) | 本轮专项调研 + 独立评审：客户端能力/FFmpeg 实测/UX 规格/线框/评审意见 | ✅ 已交付 |
| [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) | 发布前检查清单 | ✅ v1.0 |
| [legal/](./legal/) | 隐私政策/用户协议/版权投诉/隐私指引配置 | 🟡 待补主体与联系方式 |

## 历史草稿

`docs/archive/` 保留了工作区中由其他工具/早期版本生成的文档草稿，仅作追溯，不作为当前依据：

- `archive/PRD-draft-v0.1-20261027.md`、`TASK_PLAN-draft-v0.1-20261027.md`、`DEV_LOG-draft-v0.1-20261027.md`
- `archive/ai-assistant-v0.2/` — 另一 AI 助手在 2026-10-27 21:49~21:50 覆盖写入的版本
- `archive/ai-assistant-v0.3/` — 另一 AI 助手在 22:46 覆盖写入的 TASK_PLAN/DEV_LOG 版本

> 注意：工作区可能存在其他 AI 工具并发写入；本目录文档已设为只读保护，如需编辑请先 `chmod +w`。

## 维护规则

- 事实变更：先更新 FEASIBILITY，再同步 TASK_PLAN/PRD/DEV_LOG。
- 决策变更：在 DEV_LOG 追加 ADR，再更新 TASK_PLAN/PRD。
- 每次提交/测试/提审：更新 DEV_LOG。
- 文档与代码同仓，使用相对链接；外部事实附官方 URL 与核实日期。
