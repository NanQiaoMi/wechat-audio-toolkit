# 音乐音频格式转换小程序 - 产品需求规格说明书 (PRD)

## 1. 文档基本信息

| 属性 | 内容 |
| :--- | :--- |
| **产品名称** | 音乐音频格式转换小程序 (AudioConvert Pro) |
| **文档版本** | v1.0.0 (基于微信官方云开发标准规范) |
| **基准文档** | [微信官方云开发快速开始指引](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/basis/getting-started.html) |
| **运行环境** | 微信开发者工具 / 微信客户端 (iOS, Android, Windows, macOS) |
| **核心技术底座** | 微信原生小程序框架 + 微信云开发 (云存储 Cloud Storage + 云函数 Cloud Functions + 云数据库 Cloud Database) + 静态 FFmpeg 引擎 |

---

## 2. 背景与产品定位

### 2.1 用户痛点
1. **微信内音频格式碎片化**：用户日常在微信中高频接收各种格式音频（如 iPhone 语音备忘录 `.m4a`、高品质无损伴奏 `.flac`、微信旧版语音 `.amr`、开源游戏/网页 `.ogg`、未压缩工程 `.wav` 等）。但在车载 U 盘、办公系统、老旧播放器中，普遍仅严格识别标准 `.mp3` 格式。
2. **转换链路割裂繁琐**：传统转换需要导出至电脑端，安装庞大的格式工厂或 Audacity；或者使用充满广告、存在隐私泄露风险的网页端转码工具。
3. **缺少微信生态闭环**：无法直接从微信聊天文件拾取，转换后无法一键发送回微信好友或微信群。

### 2.2 产品定位与核心价值
**“微信生态内一站式、高保真、零外链依赖的音乐格式轻量转换神器”**
- **免安装**：无需离开微信生态，直接从会话中读取音频文件；
- **全格式支持**：基于成熟的云端 FFmpeg 转码流水线，覆盖 MP3、WAV、M4A、AAC、FLAC、OGG、AMR、WMA；
- **原生云端赋能**：严格基于微信官方云开发规范，利用云存储极速分发与云函数免鉴权弹性算力，保障音质无损与用户隐私。

---

## 3. 系统架构与数据流图

遵循[微信官方云开发体系](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/basis/getting-started.html)，充分利用云开发三大核心能力：

```mermaid
flowchart TD
    subgraph 客户端 [微信小程序前端 (Miniprogram)]
        A[wx.chooseMessageFile<br>从聊天拾取音频] --> B[wx.createInnerAudioContext<br>原音频试听与时长解析]
        B --> C[配置目标格式与音质参数<br>MP3/WAV/AAC/FLAC/OGG]
        C --> D[wx.cloud.uploadFile<br>直传至云存储临时目录]
        G[wx.cloud.downloadFile<br>拉取转码结果] --> H[新音频即时试听比对]
        H --> I1[wx.shareFileMessage<br>一键发回微信好友]
        H --> I2[wx.saveFile / wx.openDocument<br>保存至系统]
    end

    subgraph 云开发基础设施 [微信云开发基座 (CloudBase)]
        D --> E1[(云存储 Cloud Storage<br>temp_audios/)]
        E1 --> F[云函数 audioConvert<br>Node.js + FFmpeg 转码核心]
        F --> E2[(云存储 Cloud Storage<br>converted_audios/)]
        E2 --> G
        F -.-> J[(云数据库 Cloud DB<br>记录转换任务流水)]
    end
```

---

## 4. 格式支持矩阵与转码能力

### 4.1 核心支持格式一览

| 目标格式 | 容器类型 | 默认编码器 | 推荐使用场景 | 特性说明 |
| :--- | :--- | :--- | :--- | :--- |
| **MP3** (默认) | `.mp3` | libmp3lame | 车载播放、老旧设备、日常试听、办公系统上传 | 兼容性最佳，体积小 |
| **WAV** | `.wav` | pcm_s16le | 音频后期剪辑、高品质母带工程 | 无压缩无损，保真度最高 |
| **M4A / AAC** | `.m4a` | aac | Apple 生态设备、现代移动端播放 | 高压缩比，相同码率音质优于 MP3 |
| **FLAC** | `.flac` | flac | HiFi 发烧友、无损音乐备份归档 | 无损压缩，体积比 WAV 小约 40-50% |
| **OGG** | `.ogg` | libvorbis | 游戏音效开发、网页流媒体 | 开源格式，音质出众 |

### 4.2 输入格式支持范围
- **常规音频**：`.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`, `.ogg`
- **语音及遗留格式**：`.amr` (旧版微信语音/功能机录音), `.wma` (Windows Media)
- **单文件上限**：≤ 50MB（微信云存储与云函数推荐高效处理水位）

### 4.3 音频参数自定义
- **比特率 (Bitrate)**：
  - 320 kbps（超清无损听感，音乐首选）
  - 192 kbps（标准平衡，默认推荐）
  - 128 kbps（轻量体积，播客/会议录音首选）
- **采样率 (Sample Rate)**：原音频同频 / 44.1 kHz (CD级) / 48 kHz (影视广播级)
- **声道数 (Channels)**：立体声 (2 Channels) / 单声道 (1 Channel)

---

## 5. 详细功能模块说明

### 模块一：音频文件拾取 (File Ingestion)
- **功能描述**：调起微信原生会话文件选择器，用户可从任意单聊、群聊或“文件传输助手”选择音频。
- **调用 API**：`wx.chooseMessageFile({ count: 1, type: 'file', extension: [...] })`。
- **校验逻辑**：
  1. 扩展名白名单探测（如为未知扩展名但属于音频 MIME，提供提示并允许导入）。
  2. 文件大小探测，若大于 50MB 则弹出 Friendly Toast 拦截，建议压缩后再试。
- **界面展示**：卡片式展现文件名、文件大小、格式徽章、文件图标。

### 模块二：源音频预览与属性探测 (Preview & Probe)
- **内置播放器**：使用 `wx.createInnerAudioContext()`，具备进度条拖拽、当前播放时间 / 总时长。
- **格式试听适配**：系统原生支持的格式（MP3/AAC/WAV/M4A）直接试听；系统外格式（FLAC/OGG）展示“转码后可试听”提示。

### 模块三：转码目标与音质配置 (Conversion Config)
- **界面组件**：
  - 6宫格快捷格式卡片单选（MP3, WAV, M4A, AAC, FLAC, OGG）。
  - “高级音质设置”折叠抽屉：比特率单选滑块、采样率选择器、声道切换。

### 模块四：云端转码执行流水线 (Cloud Transcode Pipeline)
1. **上传原文件**：前端调用 `wx.cloud.uploadFile`，路径分配至 `temp_audios/{Date.now()}_{random}.{ext}`。
2. **触发云函数**：前端调用 `wx.cloud.callFunction({ name: 'audioConvert', data: { fileID, targetFormat, options } })`。
3. **云函数处理**：
   - 临时下载至云函数容器 `/tmp`；
   - 运行静态 FFmpeg 执行转码；
   - 将转换完成的产物通过 `cloud.uploadFile` 写入 `converted_audios/`；
   - 清理 `/tmp` 临时文件，返回转换后文件 `fileID`、下载 URL、耗时与大小。

### 模块五：转换成果展示与微信生态分发 (Export & Sharing)
- **对比看板**：直观展示转码前后体积对比（如 `15.8 MB -> 4.2 MB (压缩 73%)`）。
- **即时试听**：一键播放转换后的音频，验证转换成果与音质。
- **生态分发能力**：
  - **直接发好友**：调用 `wx.shareFileMessage`，无需跳出即可发送给微信好友。
  - **保存到设备**：调用 `wx.cloud.downloadFile` + `wx.openDocument` 唤起系统应用存储。
  - **复制链接**：生成 2 小时临时下载链接，方便 PC 电脑端快速取用。

### 模块六：转换历史与任务管理 (History)
- **轻量持久化**：使用 `wx.setStorage` 本地存储最近 20 条转换流水，不占用过多客户端缓存。
- **支持二次利用**：历史记录支持直接唤起试听与再次导出分享。

---

## 6. 非功能性需求与规范

1. **安全性与合规**：
   - 严格遵循微信开放平台安全规范；
   - 云存储临时音频配置生命周期规则（24 小时自动物理销毁），保护用户私人音频隐私。
2. **容错与超时保护**：
   - 云函数超时时间设置 60s；
   - 针对损坏音频、非法编码自动返回标准错误码与友好解释，杜绝白屏与未捕获异常。
3. **性能指标**：
   - 页面冷启动耗时 ≤ 700ms；
   - < 20MB 音频云端转码耗时 ≤ 5 秒。
