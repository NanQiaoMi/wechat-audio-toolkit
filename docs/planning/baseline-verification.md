# 改动前验证基线（baseline-verification）

> 任务：task-1（基础验证基线，供 v5.1 改动后回归对比）
> 执行人：verifier（只读验证；唯一写入文件为本报告）
> 执行时间：2026-10-31 03:45–03:49 CST
> 仓库：`/Users/mimi/WeChatProjects/miniprogram-1`
> 分支：`feature/v5.1-audio-capture-library`
> 基线提交：`d55310f`（`chore: baseline v5.0 snapshot (2026-10-31)`），执行开始时 `git status --porcelain -uall` 为 0 行（工作区干净）
> 说明：本任务未修改任何代码/配置，未执行任何 git 写操作；所有命令均在本机实际执行，命令、退出码、关键输出见下文。

## 一、结论摘要

| # | 检查项 | 命令入口 | 退出码 | 结果（基线数字） | 判定 |
|---|--------|----------|--------|------------------|------|
| 1 | JS 语法检查（任务指定 10 个文件） | `node --check` 逐文件 | 全部 0 | **10/10 通过** | ✅ |
| 2 | 前端自动化测试 | `node scripts/editor-spike/frontend-test.js` | 0 | **41/41 通过，0 失败** | ✅ |
| 3 | 云函数纯函数单测 | `node scripts/editor-spike/test_pure.js` | 0 | **pass=150 fail=0** | ✅ |
| 4 | 结构检查（JSON/WXML/WXSS/pages 对应） | 一次性内联 Node 脚本（附录 A） | 0 | **18/18 通过** | ✅ |
| 5 | DevTools CLI 可用性 | `cli --help` / `cli preview --help` | 0 / 0 | CLI 可执行；版本 36.6.0 | ✅（CLI 层） |
| 6 | DevTools IDE 服务端口 44120 | `lsof` / `nc -z` | 1 / 1 | 未监听，IDE 未运行 | ⚠️ 环境未就绪 |
| 7 | Docker（容器化 Node16 / FFmpeg 实测） | `docker --version` / `run.sh --pure` | 0 / **1** | CLI 28.3.0 存在，**daemon 未运行**；run.sh 在 Node16 阶段失败 | ⚠️ 环境未就绪 |

**自动化基线总数：41（前端）+ 150（后端纯函数）= 191 项全部通过**，与 `docs/DEV_LOG.md` v5.0 条目记录的「191 项（150 后端纯函数 + 41 前端端到端集成）」一致。**已执行的检查无基线失败项。**

## 二、环境与工具链

| 项 | 值 | 证据命令 / 输出 |
|----|----|-----------------|
| 系统 PATH 中的 node | **不存在** | `which node` → 无输出，exit=1 |
| DSH 内置 Node | `v24.21.0`，路径 `/Users/mimi/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node` | `"$NODE" --version` → `v24.21.0` |
| Docker CLI | `Docker version 28.3.0, build 38b7060` | `docker --version` exit=0 |
| Docker daemon | **未运行** | `docker info` → `Cannot connect to the Docker daemon at unix:///Users/mimi/.docker/run/docker.sock. Is the docker daemon running?`；`docker ps` 同 |
| 微信开发者工具 | `36.6.0 (36.6.0)` | `/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/wechatwebdevtools.app/Contents/Info.plist` |
| DevTools CLI | `/Applications/wechatwebdevtools.app/Contents/MacOS/cli` 存在且可执行（wrapper，53 行，实际入口 `Contents/Resources/app.asar.unpacked/js/common/cli/index.js`） | `ls -l` 权限 `-rwxr-xr-x` |
| `WECHAT_DEVTOOLS_CLI_TOKEN` | unset | `[ -n "$WECHAT_DEVTOOLS_CLI_TOKEN" ]` 判断（不打印值） |

统一命令前缀（下文均省略重复定义）：

```bash
cd /Users/mimi/WeChatProjects/miniprogram-1
NODE=/Users/mimi/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node
```

## 三、静态检查（node --check）

目标文件（共 10 个，任务指定全量）：

```bash
FILES=$(ls miniprogram/app.js miniprogram/envList.js miniprogram/utils/*.js \
  miniprogram/pages/*/*.js \
  cloudfunctions/ffmpegProbe/index.js cloudfunctions/ffmpegProbe/lib/*.js \
  cloudfunctions/audioConvert/index.js)
for f in $FILES; do
  OUT=$("$NODE" --check "$f" 2>&1); RC=$?
  [ $RC -eq 0 ] && echo "PASS rc=0  $f" || { echo "FAIL rc=$RC  $f"; echo "$OUT"; }
done
```

实测输出（全量 10 个文件，**均 exit=0**）：

```text
PASS rc=0  cloudfunctions/audioConvert/index.js
PASS rc=0  cloudfunctions/ffmpegProbe/index.js
PASS rc=0  cloudfunctions/ffmpegProbe/lib/editor-core.js
PASS rc=0  miniprogram/app.js
PASS rc=0  miniprogram/envList.js
PASS rc=0  miniprogram/pages/editor/editor.js
PASS rc=0  miniprogram/pages/index/index.js
PASS rc=0  miniprogram/pages/settings/settings.js
PASS rc=0  miniprogram/utils/editor-utils.js
PASS rc=0  miniprogram/utils/mono-icons.js
```

补充（非任务必需，便于后续回归）：`scripts/editor-spike/*.js` 4 个脚本也全部 `node --check` rc=0（frontend-test.js、test_actions_mock.js、test_integration.js、test_pure.js）。

> 注意：宿主机 Node 为 v24.21.0，而云函数运行时为 Nodejs16.13（DEV_LOG 记录），`node --check` 通过**不等于** Node16 语法兼容；Node16 兼容性测试需 Docker（当前 daemon 未运行，见 §五）。

## 四、自动化测试

### 4.1 前端测试

```bash
"$NODE" scripts/editor-spike/frontend-test.js; echo "exit=$?"
```

- 退出码：**0**
- 耗时：约 4 秒（03:46:56 → 03:47:00）
- 结果：`结果：41 项全部通过`（41 PASS / 0 FAIL，日志共 44 行）
- 覆盖（文件头注释）：editor-utils 纯函数断言；editor.wxml 标签配对 + 事件处理函数存在性 + `wx:for`/`wx:key`；editor.wxss 花括号、editor.json；页面冒烟（多源导入→分割/排序/ripple 删除/裁剪→淡入淡出→跨源预览→v2 导出→转发→切 tab）
- 失败项：无

### 4.2 云函数纯函数单测

```bash
"$NODE" scripts/editor-spike/test_pure.js; echo "exit=$?"
```

- 退出码：**0**
- 耗时：<1 秒（03:47:05）
- 结果：`纯函数单测: pass=150 fail=0`、`全部通过 ✅`（日志 168 行）
- 分节（日志 `^#` 标题）：`parseProbeInfo`、`computePeaks`、`normalizeEditRequest`、`clampSegmentsToDuration/finalizePlan`、`buildFilterGraph/buildRenderArgs`、`playableFlags`、v2 多源片段/每片段缓入缓出
- 失败项：无

### 4.3 Docker 与容器化测试探测

```bash
docker --version          # exit=0，Docker version 28.3.0
docker info               # exit=0（CLI 层），但 stderr: 无法连接 dockerd
bash scripts/editor-spike/run.sh --pure   # exit=1
```

`run.sh --pure` 实测过程（完整输出见 `/tmp/dsh-verifier-run-sh-pure.log`）：
1. 宿主机纯函数单测重跑：`纯函数单测: pass=150 fail=0`、`全部通过 ✅`（通过）；
2. 进入 Node16 容器单测阶段 `[run] 纯函数单测（Node 16: node:16-alpine）`；
3. `docker: Cannot connect to the Docker daemon ...`；
4. `[err] 纯函数单测失败（Node16）`，脚本 **exit=1**。

结论：Docker CLI 可用但 daemon 未启动，`run.sh --pure` 不能作为当前基线通过项；`test_integration.js`、`test_actions_mock.js`（依赖 `linuxserver/ffmpeg` 容器 + 静态 FFmpeg 7.0.2）**未执行**（前置条件不满足）。

## 五、结构检查

一次性 Node 脚本（全文见附录 A，通过 stdin 执行、不落盘项目文件）执行：

```bash
"$NODE" - <<'EOF' > /tmp/dsh-verifier-structure2.log 2>&1
...（附录 A）...
EOF
echo "exit=$?"
```

- 退出码：**0**
- 汇总：**pass=18 fail=0**
- 明细：
  - JSON 可解析 7/7：`miniprogram/app.json`、`miniprogram/sitemap.json`、`project.config.json`、`project.private.config.json`、3 个页面 `.json`
  - `app.json` pages ↔ 磁盘：声明 `["pages/index/index","pages/editor/editor","pages/settings/settings"]` 与磁盘目录 `["pages/index","pages/editor","pages/settings"]` **一一对应**；3 个页面 `.js/.json/.wxml/.wxss` 四件套齐全；`app.json` 无 tabBar 配置（NOTE）
  - WXML 标签配对（引号感知 tokenizer）：`editor.wxml` 684 标签/最大嵌套 13、`index.wxml` 258/9、`settings.wxml` 36/4，**全部平衡**
  - WXSS 花括号：`editor.wxss` 609/609、`index.wxss` 227/227、`settings.wxss` 10/10、`app.wxss` 5/5，**全部平衡**

> 过程备注（如实记录）：该一次性脚本首轮在 §2 因**脚本自身**把 `pages/editor/editor` 与目录名 `pages/editor` 直接比较而误报 1 项（17 pass/1 fail，日志 `/tmp/dsh-verifier-structure.log`）；修正为「取 page 路径父目录」后重跑 18/18 通过（`/tmp/dsh-verifier-structure2.log`）。这不是项目结构问题。

## 六、DevTools CLI 与项目配置探测

### 6.1 CLI 可用性

```bash
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
perl -e 'alarm shift; exec @ARGV' 25 "$CLI" --help          # exit=0
perl -e 'alarm shift; exec @ARGV' 25 "$CLI" preview --help  # exit=0
```

- `cli --help`：exit=0，命令列表含 `cloud / open / login / islogin / preview / auto-preview / upload / build-npm / auto / close / quit / cache / ...`；全局选项 `--project --appid --port --token --lang --debug -h`。
- `cli preview --help`：exit=0，支持 `--qr-format/--qr-output/--qr-size/--info-output`（`--qr-output` 即任务提及的二维码输出参数）。
- CLI 版本：微信开发者工具 36.6.0。

### 6.2 服务端口 44120 / IDE 进程

```bash
lsof -nP -iTCP:44120 -sTCP:LISTEN   # 无输出，exit=1
nc -z -w 2 127.0.0.1 44120          # exit=1
nc -z -w 1 127.0.0.1 9420 / 9421    # 均 exit=1（常见 DevTools 端口也关闭）
pgrep -f -i 'wechatwebdevtools'     # exit=1（无进程）
```

**结论：IDE 未启动、44120 未监听**（DEV_LOG 记录 ISSUE-015 曾在 23:05 开启 44120 并成功部署，当前已关闭）。`WECHAT_DEVTOOLS_CLI_TOKEN` 未设置。

### 6.3 `cli preview` 只读尝试：未执行（受约束）

未执行 `cli preview --project /Users/mimi/WeChatProjects/miniprogram-1 --qr-output /tmp/dsh-plan-qr.png`。原因（如实记录）：
- CLI 自带帮助明确写明：`--port ... If IDE hasn't been launched, it will be launched and start HTTP server at <port>`，即当前 IDE 未运行状态下执行 preview 会**拉起开发者工具主程序**；
- 任务约束要求「若需要登录/IDE 未启动则记录失败原因，不要强行启动或登录开发者工具」，故按约束不执行，而不是强行启动 GUI。

因此**本基线不含「DevTools 编译/预览通过」结论**；该项需由用户手动打开开发者工具（服务端口 44120 + 登录态）后，再由 Lead/验证者执行 preview 并补录。

### 6.4 项目配置（appid / libVersion）

任务原文写 `miniprogram/project.config.json`，实际该文件不存在（`ls miniprogram/project.config.json` → No such file，exit=1）；真实配置在仓库根目录（`miniprogramRoot: "miniprogram/"`）：

| 文件 | 关键字段 | 值 |
|------|----------|-----|
| `project.config.json` | `appid` | `wx484dd63e6a427b3b` |
| `project.config.json` | `libVersion` | `2.20.1` |
| `project.config.json` | `miniprogramRoot` / `cloudfunctionRoot` / `compileType` | `miniprogram/` / `cloudfunctions/` / `miniprogram` |
| `project.private.config.json` | `libVersion` | `3.17.5`（本地私有覆盖；以 DevTools 实际生效值为准） |

## 七、基线失败清单与未执行项

### 7.1 基线失败（已执行检查）

**无。** 10/10 语法检查、41/41 前端测试、150/150 纯函数单测、18/18 结构检查全部通过。

### 7.2 未执行项（环境受限，非代码失败）

| 项 | 原因 | 影响 | 建议 |
|----|------|------|------|
| `bash scripts/editor-spike/run.sh --pure` 的 Node16 容器阶段 | Docker daemon 未运行（`Cannot connect to the Docker daemon`）；宿主机阶段已通过 150/150 | 无法验证 Node16 语法/运行时兼容 | 用户启动 Docker Desktop 后重跑；预期 `--pure` 最终 `exit=0` |
| `test_integration.js` / `test_actions_mock.js`（Docker FFmpeg 实测） | 同上，且需容器 + 静态 FFmpeg 7.0.2 | 后端「真实 FFmpeg 渲染/action 链路」无基线数字 | Docker 就绪后 `bash scripts/editor-spike/run.sh` 全量跑 |
| `cli preview`（DevTools 编译/二维码） | IDE 未运行、44120 未监听；执行会拉起 IDE，被任务约束禁止强启 | 无 DevTools 编译基线 | 用户打开 DevTools 并开启服务端口后补测 |
| 真机/模拟器 E2E、音频听感、手势体验 | 需真机 + 登录态 + 人工判断 | 无法自动化 | 保留为人工验收清单（见 §八.3） |

## 八、后续回归命令清单（每次改动后由 Lead/验证者执行）

### 8.1 固定命令块（复制即跑）

```bash
cd /Users/mimi/WeChatProjects/miniprogram-1
NODE=/Users/mimi/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node

# R1 语法检查（任务指定 10 文件）——预期 10/10 rc=0
FILES=$(ls miniprogram/app.js miniprogram/envList.js miniprogram/utils/*.js \
  miniprogram/pages/*/*.js \
  cloudfunctions/ffmpegProbe/index.js cloudfunctions/ffmpegProbe/lib/*.js \
  cloudfunctions/audioConvert/index.js)
for f in $FILES; do "$NODE" --check "$f" || echo "SYNTAX FAIL: $f"; done; echo "syntax done"

# R2 前端测试——预期输出「结果：41 项全部通过」，rc=0（改动增加用例后数字应 ≥41 且无 FAIL）
"$NODE" scripts/editor-spike/frontend-test.js; echo "frontend exit=$?"

# R3 云函数纯函数单测——预期输出「纯函数单测: pass=150 fail=0」「全部通过 ✅」，rc=0（新增用例后数字应 ≥150 且 fail=0）
"$NODE" scripts/editor-spike/test_pure.js; echo "pure exit=$?"

# R4 结构检查（附录 A 脚本）——预期「结构检查汇总: pass=18 fail=0」，rc=0
#    命令：$NODE - <<'EOF' ...（附录 A 全文）... EOF
```

**基线对照数字**：R1 = 10/10；R2 = 41 通过 / 0 失败；R3 = 150 通过 / 0 失败；R4 = 18 通过 / 0 失败；合计 191 项自动化 + 10 文件语法 + 18 结构项。任何 FAIL 或数字下降都需在改动报告中单列。

### 8.2 按改动类型的推荐最小集

| 改动类型 | 必须重跑 |
|----------|----------|
| 仅文档（.md） | R4（JSON/WXML/WXSS 未动可跳过）+ 人工核对链接 |
| 前端 JS（miniprogram/**） | R1（改到的文件）+ R2 + R4 |
| WXML / WXSS / 页面 JSON | R2（editor 页结构 + 冒烟）+ R4 |
| cloudfunctions/**（含 editor-core.js） | R1 + R3；Docker 可用时追加 `bash scripts/editor-spike/run.sh` |
| app.json / project.config.json | R4（pages ↔ 磁盘、JSON 解析）+ R1 |
| 任何改动合并前 | R1 + R2 + R3 + R4 全量；记录数字与基线对比 |

### 8.3 不可自动化 / 只能人工验证的项

1. **DevTools 编译与预览**：需 IDE 启动 + 登录 + 44120 服务端口（本次已探测：未就绪）；`cli preview` 产物需人看二维码/编译日志。
2. **真机音频链路**：录音权限、`InnerAudioContext` 播放/静音键穿透、试听与导出成片听感、iOS/Android FLAC/OGG 行为。
3. **触屏手势交互**：双指缩放、拖拽磁吸、把手裁剪、剃刀点切等手感与 60FPS 顺畅度。
4. **云端联动**：云函数部署（`cli cloud functions deploy`）、真实云存储上传/下载、线上 FFmpeg 渲染耗时与配额。
5. **UI 视觉验收**：布局折行、颜色层级、真机安全区适配（DEV_LOG 中多项 v4.x/v5.0 均为截图反馈驱动，无法用 Node 单测覆盖）。

## 九、限制与风险说明

1. **Node 版本差异**：宿主机 DSH Node v24.21.0（系统 PATH 无 node），云端运行时 Nodejs16.13；`node --check` 与纯函数测试只能代表新版 Node 的解析/行为，Node16 兼容性需 Docker `node:16-alpine`（当前被 daemon 阻塞）。
2. **无 DevTools 编译基线**：本次无法提供「改动后 DevTools 编译通过」的起点；后续若要该证据，需先满足 §六.2 环境条件。
3. **`lsof` 全量监听列表** 只返回表头（可能受执行环境权限/沙箱影响），端口结论以针对 44120 的 `lsof`/`nc` 与 `pgrep` 三重证据为准。
4. **结构检查为「粗检」**：WXML 用引号感知 tokenizer 做标签栈配对、WXSS 做花括号深度扫描，能发现未闭合/错配，但不做 schema/属性级校验；`frontend-test.js` 内部对 editor 页另有更细的 wxml 事件/`wx:key` 检查。
5. **日志为临时文件**：证据日志位于 `/tmp/dsh-verifier-*.log`，重启/清理后消失；本报告已摘录关键输出，重跑命令可复现。

## 附录 A：结构检查一次性脚本全文（R4）

执行方式（stdin，不生成项目内文件）：

```bash
cd /Users/mimi/WeChatProjects/miniprogram-1
NODE=/Users/mimi/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node
"$NODE" - <<'EOF'
// ... 以下全文 ...
EOF
```

```js
const fs = require('fs');
const path = require('path');
const ROOT = '/Users/mimi/WeChatProjects/miniprogram-1';
const MP = path.join(ROOT, 'miniprogram');
let pass = 0, fail = 0;
const ok = m => { pass++; console.log('PASS ' + m); };
const bad = m => { fail++; console.log('FAIL ' + m); };
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('## 1. JSON 可解析性');
const pageDirs = fs.readdirSync(path.join(MP, 'pages')).filter(d => fs.statSync(path.join(MP, 'pages', d)).isDirectory()).sort();
const jsonFiles = ['miniprogram/app.json', 'miniprogram/sitemap.json', 'project.config.json', 'project.private.config.json']
  .filter(p => fs.existsSync(path.join(ROOT, p)))
  .concat(pageDirs.map(d => `miniprogram/pages/${d}/${d}.json`));
const parsed = {};
for (const f of jsonFiles) {
  try { parsed[f] = JSON.parse(read(f)); ok(`${f} JSON.parse 成功`); }
  catch (e) { bad(`${f} JSON.parse 失败: ${e.message}`); }
}

console.log('\n## 2. app.json pages vs 磁盘（按 page 路径的父目录与磁盘 page 目录比对）');
const app = parsed['miniprogram/app.json'];
const declared = [...(app.pages || [])];
for (const sp of (app.subPackages || [])) for (const p of (sp.pages || [])) declared.push((sp.root + '/' + p).replace(/\/+/g, '/'));
const appDirs = [...new Set(declared.map(p => path.posix.dirname(p)))].sort();
const diskDirs = pageDirs.map(d => `pages/${d}`).sort();
console.log('app.json pages: ' + JSON.stringify(declared.slice().sort()));
console.log('app.json 对应目录: ' + JSON.stringify(appDirs));
console.log('磁盘 page 目录: ' + JSON.stringify(diskDirs));
if (JSON.stringify(appDirs) === JSON.stringify(diskDirs)) ok('app.json pages 与磁盘 page 目录一一对应');
else bad(`不一致: 仅声明=[${appDirs.filter(p => !diskDirs.includes(p))}] 仅磁盘=[${diskDirs.filter(p => !appDirs.includes(p))}]`);
for (const p of declared.sort()) {
  const extMissing = ['.js', '.json', '.wxml', '.wxss'].filter(e => !fs.existsSync(path.join(MP, p + e)));
  if (extMissing.length === 0) ok(`${p}: .js/.json/.wxml/.wxss 四件套齐全`);
  else bad(`${p}: 缺少 ${extMissing.join(',')}`);
}
const tabs = (app.tabBar && app.tabBar.list) || [];
if (tabs.length) {
  const badTabs = tabs.map(t => t.pagePath).filter(p => !declared.includes(p));
  if (badTabs.length === 0) ok(`tabBar ${tabs.length} 个 pagePath 均在 pages 声明中`);
  else bad(`tabBar 存在未声明页面: ${badTabs.join(',')}`);
} else console.log('NOTE app.json 无 tabBar 配置');

function checkWxml(rel) {
  const src = read(rel);
  const n = src.length; const stack = []; const errors = [];
  let i = 0, tagCount = 0, maxDepth = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt + 4); i = end < 0 ? n : end + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const end = src.indexOf(']]>', lt + 9); i = end < 0 ? n : end + 3; continue; }
    const c = src[lt + 1] || '';
    if (c === '/') {
      const gt = src.indexOf('>', lt + 1);
      if (gt < 0) { errors.push(`位置 ${lt}: 未闭合的结束标签`); break; }
      const name = src.slice(lt + 2, gt).trim();
      if (!/^[A-Za-z][\w-]*$/.test(name)) errors.push(`位置 ${lt}: 非法结束标签 </${name}>`);
      else { const top = stack.pop(); if (!top) errors.push(`位置 ${lt}: 多余结束标签 </${name}>`); else if (top.name !== name) errors.push(`位置 ${lt}: </${name}> 与栈顶 <${top.name}> 不匹配`); }
      i = gt + 1; continue;
    }
    if (!/[A-Za-z]/.test(c)) { i = lt + 1; continue; }
    let j = lt + 1, quote = null, selfClose = false;
    while (j < n) {
      const ch = src[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') { selfClose = src[j - 1] === '/'; break; }
      j++;
    }
    if (j >= n) { errors.push(`位置 ${lt}: 标签未结束`); break; }
    const head = src.slice(lt + 1, j);
    const m = head.match(/^([A-Za-z][\w-]*)/);
    if (!m) { errors.push(`位置 ${lt}: 无法解析标签`); i = j + 1; continue; }
    tagCount++;
    if (!selfClose) { stack.push({ name: m[1], pos: lt }); maxDepth = Math.max(maxDepth, stack.length); }
    i = j + 1;
  }
  for (const s of stack) errors.push(`位置 ${s.pos}: 标签 <${s.name}> 未闭合`);
  if (errors.length === 0) ok(`${rel}: 标签开闭平衡（标签数 ${tagCount}，最大嵌套 ${maxDepth}）`);
  else bad(`${rel}: ${errors.length} 处不平衡 → ${errors.slice(0, 5).join('; ')}`);
}
console.log('\n## 3. WXML 标签配对粗检');
for (const d of pageDirs) checkWxml(`miniprogram/pages/${d}/${d}.wxml`);

function checkWxss(rel) {
  const src = read(rel);
  let depth = 0, ob = 0, cb = 0, i = 0, err = null;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (ch === '"' || ch === "'") { const q = ch; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } i++; continue; }
    if (ch === '{') { ob++; depth++; } else if (ch === '}') { cb++; depth--; if (depth < 0 && !err) err = `位置 ${i}: 多余 }`; }
    i++;
  }
  if (err) bad(`${rel}: ${err}（{=${ob} }=${cb}）`);
  else if (depth === 0) ok(`${rel}: 花括号平衡（{=${ob} }=${cb}）`);
  else bad(`${rel}: 花括号不平衡 {=${ob} }=${cb} depth=${depth}`);
}
console.log('\n## 4. WXSS 花括号配对');
for (const f of pageDirs.map(d => `miniprogram/pages/${d}/${d}.wxss`).concat(['miniprogram/app.wxss'])) checkWxss(f);

console.log('\n========================================');
console.log(`结构检查汇总: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
```

## 附录 B：证据日志（临时文件，可重跑再生）

| 文件 | 内容 |
|------|------|
| `/tmp/dsh-verifier-frontend-test.log` | frontend-test.js 全量输出（44 行，末行「结果：41 项全部通过」） |
| `/tmp/dsh-verifier-test-pure.log` | test_pure.js 全量输出（168 行，末行「纯函数单测: pass=150 fail=0 / 全部通过 ✅」） |
| `/tmp/dsh-verifier-run-sh-pure.log` | `run.sh --pure` 输出（174 行，末尾 Node16 docker 连接失败，exit=1） |
| `/tmp/dsh-verifier-cli-help.log` | `cli --help` 输出（42 行） |
| `/tmp/dsh-verifier-cli-preview-help.log` | `cli preview --help` 输出（31 行） |
| `/tmp/dsh-verifier-structure.log` | 结构检查首轮输出（17 pass/1 fail，脚本自身比对误报） |
| `/tmp/dsh-verifier-structure2.log` | 结构检查修正后输出（18 pass/0 fail，最终基线） |

---

*报告结束。本报告为改前基线，后续 v5.1 改动不得修改本文件的历史数字；如需更新结论，请在改动记录中引用本文件并单列差异。*
