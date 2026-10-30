# 在线音乐编辑 · 实现契约（MVP，2026-10-28）

> **状态：v1 与 v2 均已实现并 E2E 通过**（v1 双 tab 单文件；v2 多源片段拼接 + 每片段缓入缓出）。部署与 devtools E2E 记录见 [DEV_LOG](./DEV_LOG.md) 12:xx/13:xx 行与 [MUSIC_EDITOR_DESIGN §19](./MUSIC_EDITOR_DESIGN.md)。

> 目的：把 v0.2 设计落成可运行的小程序内「第二个入口」。本文件只约束实现接口与文件边界；产品边界/限额以 [MUSIC_EDITOR_DESIGN.md](./MUSIC_EDITOR_DESIGN.md) 为准。
> 本次范围：同一小程序内两个入口可切换（格式转换 / 音乐剪辑）；剪辑 MVP = 单文件、裁剪/删除、淡入淡出、音量、导出 MP3、结果试听/转发。

## 1. 入口切换（Lead 负责）

- `miniprogram/app.json` 增加 `tabBar`：`pages/index/index`（转换）、`pages/editor/editor`（剪辑），文字+蓝色选中，不依赖图标。
- 首页保留现有转换流程；新增一行提示/入口指向剪辑（tabBar 已可切换，卡片可选）。
- 剪辑页是 tab 页，`navigationBarTitleText: "音乐剪辑"`；设置页仍从首页进入。

## 2. 小程序端文件边界

| 角色 | 唯一写入范围 |
| :--- | :--- |
| 前端 | `miniprogram/pages/editor/**`、`miniprogram/utils/editor-*.js` |
| 后端 | `cloudfunctions/ffmpegProbe/index.js`（追加 action/函数，**不破坏 convertFile**）、`cloudfunctions/ffmpegProbe/lib/**`、`scripts/editor-spike/**` |
| Lead | `miniprogram/app.json`、`miniprogram/pages/index/**`（仅小改入口）、docs、集成测试 |

## 3. 上传与云函数约定

客户端上传源文件：`wx.cloud.uploadFile({ cloudPath: edit_sources/${Date.now()}_${rand}.${ext}, filePath })` → `fileID`。

### 3.1 `analyzeAudio`

请求：

```json
{ "action": "analyzeAudio", "fileID": "cloud://...", "fileName": "demo.mp3", "size": 123456 }
```

成功：

```json
{
  "success": true,
  "data": {
    "duration": 245.612,
    "format": "mp3",
    "sampleRate": 44100,
    "channels": 2,
    "bucketMs": 50,
    "buckets": 4913,
    "peaks": { "peak": "<base64 uint8>", "rms": "<base64 uint8>" },
    "playableIos": true,
    "playableAndroid": true
  }
}
```

失败：`{ success:false, code:"DECODE_FAILED"|"DURATION_TOO_LONG"|"FILE_TOO_LARGE"|"INVALID_FILE"|"INTERNAL", errorMessage:"用户可读文案" }`

服务端实现要求：
- `cloud.downloadFile(fileID)` → `/tmp/ed_analyze_*.ext`；
- 未打包 ffprobe，用 `ffmpeg -hide_banner -nostdin -i file 2>&1` 解析 stderr（Duration / Audio 行；退出码恒 1，不能以退出码判失败）；
- 时长 >600s → `DURATION_TOO_LONG`；无 Audio 行 → `DECODE_FAILED`；
- 解码 `ffmpeg -v error -nostdin -i file -ac 1 -ar 4000 -f s16le /tmp/ed_analyze_*.pcm`，按 200 samples（50ms）分桶：peak=max|s16|/32768、rms=sqrt(mean(s^2))/32768，量化为 uint8 0–255，base64，两数组等长；
- 返回 `playableIos = format ∈ {mp3,m4a,aac,wav}`，`playableAndroid` 同（Android 还支持 flac/ogg，MVP 可都返回 true）；
- `finally` 清理 /tmp 临时文件；超时 ≤20s。

### 3.2 `renderEdit`

请求：

```json
{
  "action": "renderEdit",
  "fileID": "cloud://...",
  "fileName": "demo.mp3",
  "segments": [{ "in": 12.5, "out": 45.0 }, { "in": 60.0, "out": 90.0 }],
  "fadeIn": 0,
  "fadeOut": 1.5,
  "volumeDb": 0,
  "format": "mp3",
  "bitrate": "192k"
}
```

成功：

```json
{
  "success": true,
  "data": {
    "fileID": "cloud://.../edited_audios/xxx.mp3",
    "fileName": "demo_剪辑.mp3",
    "size": 2531123,
    "duration": 62.0,
    "costMs": 8123
  }
}
```

服务端要求：
- 校验：`segments` 1～20 个、数字、`0 <= in < out`、`out-in >= 0.2`、总时长 ≤600s；文件 ≤50MB；
- 下载源 → `/tmp/ed_render_*.ext`；
- FFmpeg 参数（参考 FFMPEG_EDIT_SPIKE，7.0.2）：
  - 每段 `[0:a]atrim=start={in}:end={out},asetpts=PTS-STARTPTS[s{i}]`
  - `concat=n=N:v=0:a=1[cat]`
  - 整体 fade：`afade=t=in:st=0:d={fadeIn}` / `afade=t=out:st={outDur-fadeOut}:d={fadeOut}`（在 concat 之后，st 用输出时间轴）
  - `volume={volumeDb}dB`（0 可省略）；`alimiter=limit=0.95:level=false`
  - 输出 mp3：`-c:a libmp3lame -b:a 192k`；`-map_metadata -1 -t {outDur}`；`-filter_complex_threads 1`
- `execFile(bin, args, { timeout: 50000, killSignal: 'SIGKILL', maxBuffer: 4MB })`；
- 上传 `edited_audios/{ts}_{rand}.mp3`；写 `converted_files`（若集合存在，字段 `{openid,fileID,size,format,createdAt}`，kind 可选）；
- 返回 fileID（不返回长期 URL）；失败返回 `{success:false,code,errorMessage}`；
- 现有 `convertFile` 行为不变；action 分发追加 `analyzeAudio` / `renderEdit`。

## 4. 前端 MVP 交互（editor 页）

- 空态：大按钮「从微信聊天选择音频」+ 说明（文件 ≤10min/50MB；iOS 不支持 flac/ogg 等试听）。
- 选择后：上传（`wx.showLoading` 文案「上传中」）→ `analyzeAudio` → 进入编辑。
- 编辑态：
  - 顶部：文件名 + 总时长；
  - Canvas 波形（峰值柱 + 选区遮罩 + 播放头）；
  - 手势：点按定位播放头；拖动新建选区；选区显示起止 `mm:ss.S` 与时长；
  - 按钮：播放/暂停、试听选区、全选、保留选区、删除选区、撤销；
  - 效果：淡入（0/0.5/1/2/3s）、淡出、音量滑杆（-24～+12dB），显示当前值；
  - 底部：导出 MP3（主按钮），显示预计时长；
  - 时长/片段数实时计算；总时长 >600s 禁用导出并提示。
- 预览：用**本地临时文件** `file.path` 作为 `InnerAudioContext.src`；按 segments 顺序 `seek(in)`→`play()`，`onTimeUpdate` 到 `out` 切下一段/停止；切换页面/重新选文件先 `stop()`；`onHide/onUnload` 销毁。选区试听只播 selection。
- 导出：调用 `renderEdit`，成功后结果区显示时长/大小，按钮「试听成片」「转发给好友」。转发：先 `wx.cloud.downloadFile({fileID})` 拿临时路径（在点击事件里同步完成后再调 `shareFileMessage` 不可行，需参考现有首页做法：提前预下载缓存路径，或先准备再点第二次）；MVP 可简化：点击「转发」时若已有缓存路径直接 `shareFileMessage`，否则先下载并提示再点一次。
- 异常：上传失败/分析失败/导出失败给明确文案；`playableIos=false` 时显示「iPhone 不支持该格式试听，可导出后试听」并禁用预览按钮。

## 5. 验收（Lead 集成）

- 开发者工具可编译通过；tabBar 两个入口可切换；
- 选一段 3min MP3：出波形，拖选区，删除，试听，导出 MP3 成功，结果可试听；
- 导出的成片时长 = 计划时长（±0.2s），文件可播放；
- 现有格式转换流程回归正常；
- 代码无 lint 级语法错误，云函数部署成功（如可部署）。

---

# 6. 迭代 v2：多片段拼接 + 每片段缓入缓出（2026-10-28）

> 用户要求：「要能实现片段拼接和每个片段缓入缓出的功能，像剪辑软件一样的操作逻辑」。
> 在 v1 单文件单轨基础上扩展为**多源、多片段时间线**；v1 已有行为尽量保留。

## 6.1 产品交互（前端）

### 导入
- `wx.chooseMessageFile({ count: 5, type: 'file', extension: [...音频] })`，可一次选多个；也可在编辑页点「添加音频」继续追加。
- 每个文件：上传 → `analyzeAudio`（逐个，显示「上传/分析 i/n」）→ 作为 **1 个片段**追加到 `clips`。
- 限制：最多 5 个源文件；每个源 ≤50MB、≤10min；所有片段成片总时长 ≤600s；片段数 ≤40。

### 片段时间线（核心）
- 页面顶部显示「共 N 段 · 预计 mm:ss」。
- **片段条**（横向滚动卡片列表）：每张卡片显示序号、源文件名（截断）、片段时长、淡入/淡出标记；选中态高亮。
- 选中片段后可操作：
  - **上移 / 下移**（调整拼接顺序；MVP 用按钮，后续再做拖拽排序）
  - **删除片段**
  - **在播放头分割**：把当前片段在播放头（源时间）处切成两段；两段都 ≥0.2s 才允许
  - **裁剪到选区**：用当前选区作为该片段的新 in/out（≥0.2s）
  - **重置片段**：恢复该源文件的完整时长
  - **删除选区**（跨片段拼接的 ripple delete）：把片段按选区切成左/右两段（选区在边缘则只保留一侧；<0.2s 残片丢弃）
  - **撤销**（片段列表快照，最多 30 步）
- **每片段缓入缓出**：选中片段后，效果面板出现「本片段淡入 / 本片段淡出」选项（0 / 0.5 / 1 / 2 / 3s），分别写入 `clip.fadeIn/fadeOut`；片段卡片显示 `淡入1s/淡出0.5s` 标记。规则：每个片段独立，0 表示无；若 `fadeIn+fadeOut > 片段时长`，导出时按比例缩短（前后端一致）。
- 全局音量仍保留（-24~+12dB，作用于整条成片）；全局淡入淡出移除（改为每片段）。
- 波形区显示**当前选中片段所属源文件**的完整波形；片段 in/out 之外的区域灰化；选区遮罩与播放头沿用；点按 seek、拖动选区。
- 预览：支持「试听全部」（按 clips 顺序跨源播放）与「试听本片段」；每个片段的淡入淡出用音量包络近似；切源时先切换 `InnerAudioContext.src` 再 seek/play。
- 导出：把 `sources[]` + `clips[]` 发给 `renderEdit`，导出中禁止编辑；结果/转发逻辑沿用 v1。

## 6.2 客户端数据模型（editor.js）

```js
sources: [{
  id: 's1', fileID: 'cloud://...', localPath: 'http://tmp/...',
  name: 'a.mp3', size: 12345, duration: 245.6, format: 'mp3',
  sampleRate: 44100, channels: 2,
  peaks: { peak: Uint8Array, rms: Uint8Array }, bucketMs: 50,
  playable: true, metaText: 'MP3 · 44.1kHz · 立体声'
}],
clips: [{
  id: 'c1', sourceId: 's1', in: 0, out: 30.5,
  fadeIn: 0, fadeOut: 0
}],
selectedClipIndex: 0,
volumeDb: 0,
// 状态机沿用：empty/uploading/analyzing/editing/exporting/result
```

- `clips` 顺序即成片顺序；同一源可被多个片段引用（分割会复用 sourceId）。
- `segmentCount` 改为 `clips.length`；`planDuration = Σ(out-in)`。
- 预览队列项：`{ clipId, sourceId, localPath, in, out, fadeIn, fadeOut, offset }`，`offset` 为成片时间轴起点。

## 6.3 `renderEdit` v2 请求/响应（后端）

请求：

```json
{
  "action": "renderEdit",
  "sources": [
    { "fileID": "cloud://...a.mp3", "fileName": "a.mp3", "size": 123456 },
    { "fileID": "cloud://...b.wav", "fileName": "b.wav", "size": 234567 }
  ],
  "clips": [
    { "sourceIndex": 0, "in": 0, "out": 12.5, "fadeIn": 1, "fadeOut": 0.5 },
    { "sourceIndex": 1, "in": 3.0, "out": 9.0, "fadeIn": 0, "fadeOut": 2 }
  ],
  "volumeDb": -3,
  "format": "mp3",
  "bitrate": "192k"
}
```

成功/失败响应与 v1 相同（`{success:true,data:{fileID,fileName,size,duration,costMs}}` / `{success:false,code,errorMessage}`）。

校验：
- `sources` 1~5；每个 ≤50MB；`clips` 1~40；`sourceIndex` 合法；`0 <= in < out`；单片 ≥0.2s；成片总时长 ≤600s；
- 每片 `fadeIn/fadeOut` 归一化：≥0、≤5；若 `fadeIn+fadeOut > clipDur`，等比缩到 `clipDur`（前后端一致）；
- 服务端按每个源的真实时长 clamp 片段的 in/out；
- 下载每个源到 `/tmp/ed_render_s{i}_*`，逐个 `ffmpeg -i` 探测（失败给 `INVALID_FILE`/`DECODE_FAILED`）。

FFmpeg filter graph：
- 同一 source 被多个 clip 引用时，先 `[{s}:a]asplit={k}[s{s}_{j}]...`；只引用一次则直接用 `[{s}:a]`。
- 每个 clip：`[label]atrim=start={in}:end={out},asetpts=PTS-STARTPTS` + 可选 `afade=t=in:st=0:d={fadeIn}` + 可选 `afade=t=out:st={dur-fadeOut}:d={fadeOut}` → `[c{j}]`（**每片 fade 在 concat 前、按片段本地时间轴**）。
- `[c0]...[cn]concat=n=N:v=0:a=1[cat]`。
- 全局：`volume={volumeDb}dB`（0 可省）+ `alimiter=limit=0.95:level=false`；输出 mp3 192k；`-filter_complex_threads 1 -map_metadata -1 -t {totalDur}`；`execFile` timeout 50s + SIGKILL。
- 兼容：没有 `sources/clips` 但带 `segments` 时走 v1 逻辑；v2 请求不读顶层 `fadeIn/fadeOut`。

## 6.4 验收
- 2 个源文件 → 2 个片段：默认顺序拼接，导出时长 = 两段之和（±0.2s）；
- 上移/下移后导出顺序随之变化；
- 同一源片段 A 在播放头分割成 A1/A2，可分别设置淡入淡出；
- 每片段淡入淡出独立生效（导出后用波形/RMS 验证首尾包络）；
- 删除选区后成片长度按剩余片段计算；
- 预览跨源连续播放，无崩溃；导出结果可试听/转发；
- 旧版 v1 单文件导出回归通过。
