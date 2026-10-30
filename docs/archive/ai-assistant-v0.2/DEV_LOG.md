# 音乐音频格式转换小程序 - 开发记录 (DEV_LOG)

## 1. 项目概况

- **项目名称**：音乐音频格式转换小程序 (AudioConvert Pro)
- **AppID**：`wx484dd63e6a427b3b`
- **官方参考文档**：[微信官方云开发快速开始指引](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/basis/getting-started.html)
- **目录规划**：
  - `miniprogram/`：小程序原生前端工程（页面、组件、样式、工具类）
  - `cloudfunctions/`：微信云开发云函数（后端转码微服务）
  - `docs/`：项目全生命周期文档（PRD、任务规划、开发记录）

---

## 2. 架构决策记录 (ADR)

### ADR-001：转码核心采用微信云开发云函数 + 静态 FFmpeg
- **日期**：2026-10-27
- **决策内容**：放弃纯前端 WebAssembly 方案与重型自建独立服务器方案，全面拥抱微信官方云开发架构（CloudBase）。
- **依据与收益**：
  1. 微信小程序环境存在主包 2MB 限制，且移动端 Wasm 内存过大会被系统强制杀后台。
  2. 采用微信云开发云函数，天然自带微信开放平台身份鉴权（`cloud.getWXContext()`），免去传统后端跨域、域名备案、SSL 证书配置的繁杂流程。
  3. 通过云存储（Cloud Storage）实现音频快速分发与 24 小时生命周期自动物理回收，完美保护用户隐私并降低存储成本。

### ADR-002：文件导入采用微信原生会话拾取器
- **日期**：2026-10-27
- **决策内容**：使用 `wx.chooseMessageFile` 替代系统相册/通用文件拾取。
- **依据与收益**：
  - 微信生态内用户绝大多数音频均沉淀在微信单聊、群聊或“文件传输助手”中，原生会话文件选择器在 iOS 和 Android 上体验最统一且支持扩展名精准过滤。

### ADR-003：双轨音频播放与生命周期治理
- **日期**：2026-10-27
- **决策内容**：采用 `wx.createInnerAudioContext` 实现转码前与转码后的音频即时试听比对，并在页面的 `onHide` 和 `onUnload` 生命周期中执行 `destroy()`。
- **依据与收益**：
  - 杜绝用户返回或切后台时音频继续播放产生杂音，防止内存泄漏。

---

## 3. 开发里程碑与变更日志 (Changelog)

### [v0.1.0] - 2026-10-27
#### 新增 (Added)
- **需求与规划制定**：
  - 对齐微信官方云开发规范，编写 [docs/PRD.md](file:///Users/mimi/WeChatProjects/miniprogram-1/docs/PRD.md)。
  - 完成全流程 WBS 任务拆解文档 [docs/TASK_PLAN.md](file:///Users/mimi/WeChatProjects/miniprogram-1/docs/TASK_PLAN.md)。
  - 建立开发记录文档 [docs/DEV_LOG.md](file:///Users/mimi/WeChatProjects/miniprogram-1/docs/DEV_LOG.md)。
- **官方文档对齐**：
  - 深入分析 [微信云开发快速开始文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/basis/getting-started.html)，梳理了小程序云开发开通、环境初始化、云存储临时路径规划与云函数配置。

---

## 4. 微信云开发基础环境配置指南 (根据官方文档)

为了确保小程序正常调用云能力，需在微信开发者工具中完成如下设置：

1. **开通云开发**：
   - 打开微信开发者工具，点击顶部工具栏的 **「云开发」** 按钮；
   - 根据提示创建云开发环境（例如命名为 `audioconvert-dev`），获取到专属的 **环境 ID (Env ID)**。
2. **初始化配置**：
   - 在 `miniprogram/app.js` 中，云开发初始化支持配置具体环境 ID，若为空则默认选择当前默认环境：
     ```javascript
     wx.cloud.init({
       env: this.globalData.env || undefined,
       traceUser: true,
     });
     ```
3. **部署云函数**：
   - 当在 `cloudfunctions/audioConvert` 编写完成云函数后，在微信开发者工具左侧目录树中右键点击该目录，选择 **「上传并部署：云端安装依赖」**。

---

## 5. 当前任务与待办列表 (TODO)

- [ ] **TODO-1**：优化 `miniprogram/app.js` 云开发初始化，容错未填环境 ID 的默认场景。
- [ ] **TODO-2**：搭建 `cloudfunctions/audioConvert` 转码云函数框架与转码命令逻辑。
- [ ] **TODO-3**：编写前端主界面 `miniprogram/pages/index/`（卡片式文件选择、格式六宫格、参数设置、播放条）。
- [ ] **TODO-4**：联调文件直传云存储与云函数转码调用。
