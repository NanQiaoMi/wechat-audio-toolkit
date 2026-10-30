# ffmpegProbe（路线 A 技术验证函数）

> 目标：验证「云开发云函数 + 精简/静态 FFmpeg」能否支撑音频转码（包体、/tmp、执行、超时、冷启动）。
> **仅用于验证，不作为正式业务函数**；验证通过后改造成正式转换函数，失败则改用微信云托管（路线 B）。

## 目录

```
ffmpegProbe/
├── index.js          # 三种动作：probe / sleep / convert
├── package.json
├── bin/ffmpeg        # Linux x86_64 静态 FFmpeg（v7.0.2，76MB；zip 压缩后约 28MB）
└── README.md
```

## 部署

方式一（推荐，CLI，需要开发者工具「设置-安全设置-服务端口」开启）：

```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy \
  --env cloud1-d0g1pwjogd2f39be2 \
  --names ffmpegProbe \
  --project /Users/mimi/WeChatProjects/miniprogram-1 \
  --remote-npm-install
```

方式二：微信开发者工具中右键 `cloudfunctions/ffmpegProbe` →「上传并部署：云端安装依赖」。

> 部署后请在云开发控制台「云函数 → ffmpegProbe → 配置」把超时时间调到平台允许的最大值（如 60s），否则默认超时可能只有数秒。

## 测试事件

在云开发控制台「云函数 → 测试」或小程序端调用，传入不同 event：

```json
{"action":"probe"}
{"action":"sleep","ms":5000}
{"action":"convert","seconds":300,"target":"mp3"}
{"action":"convert","seconds":1800,"target":"flac"}
```

返回字段重点看：

- `tmpWritable`：/tmp 可写
- `ffmpegOk` / `ffmpegMs`：静态二进制能否执行
- `convMs`：5/30 分钟音频转码耗时（云函数实际 CPU）
- `totalMs`：是否接近函数超时
- `memRssMB`：内存占用

## 判定标准（路线 A 通过条件）

1. 含 76MB FFmpeg 的函数包能成功部署（压缩包约 28MB，待实测平台上限）；
2. `probe` 返回 `ffmpegOk:true`；
3. `convert` 5 分钟音频 ≤ 30s、30 分钟音频在函数超时内完成；
4. `/tmp` 可写、冷启动可接受；
5. 异步任务（建任务 + 轮询）可在云函数方案内落地。

任一条不满足 → 切换路线 B（微信云托管）。
