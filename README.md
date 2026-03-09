# web-extract

一个本地 `MCP` 服务，用来把公开网页提取成更干净的正文 `Markdown`，适合给 `Codex`、其他 MCP 客户端或 LLM 工作流直接调用。

## 特性

- 支持 `extract_url` 和 `extract_many`
- 优先抽取正文，尽量移除导航、侧栏、广告等噪音
- 输出结构化字段：`title`、`author`、`publishedAt`、`markdown`、`plainText`、`images`、`warnings`
- 默认先走原生 `fetch + Readability + selector`
- 当页面疑似需要浏览器渲染、验证码/反爬拦截、或正文过短时，自动回退到 `Playwright`
- 批量提取支持有限并发，默认 `3`，避免单站点超时拖慢整批任务
- 对非 HTML 响应和 fallback 失败返回结构化错误信息，便于 MCP 客户端和 LLM 工作流做兜底处理

## 当前实现

- HTML 获取：原生 `fetch`
- 正文提取：`Readability` + 选择器兜底
- Markdown 转换：`Turndown`
- 浏览器 fallback：`playwright-core`
- 错误结构化：`errorCode`、`errorStage`、`retryable`

## 安装

```bash
npm install
```

如果本机没有 Playwright 自带浏览器，也可以直接复用本机 Chrome / Edge / Chromium。

可选环境变量：

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome-or-edge
```

### 浏览器探测顺序

优先顺序：
1. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
2. `CHROME_PATH`
3. `EDGE_PATH`
4. 系统默认常见路径
5. `which` / `where` 命令探测

### 默认会尝试的常见路径

#### macOS
- `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`

#### Linux
- `/usr/bin/google-chrome`
- `/usr/bin/chromium`
- `/usr/bin/chromium-browser`
- `/usr/bin/microsoft-edge`

#### Windows
- `C:\Program Files\Google\Chrome\Application\chrome.exe`
- `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
- `C:\Program Files\Microsoft\Edge\Application\msedge.exe`
- `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`

## 本地运行

```bash
npm start
```

## Codex 配置示例

在 `config.toml` 中加入：

```toml
[mcp_servers.web-extract]
command = "node"
args = ["/absolute/path/to/web-extract/server.js"]
startup_timeout_sec = 45
```

## 可用工具

### `extract_url`

输入：

- `url`: 网页地址
- `maxChars`: 最大输出字符数，默认 `30000`
- `timeoutMs`: 请求超时，默认 `25000`
- `playwrightFallback`: 是否允许自动浏览器回退，默认 `true`

返回字段：

- `url`
- `finalUrl`
- `status`
- `title`
- `author`
- `publishedAt`
- `sourceStrategy`
- `markdown`
- `plainText`
- `excerpt`
- `images`
- `contentLength`
- `warnings`

说明：

- 正常路径会返回 `fetch:readability`、`fetch:selector:article` 之类的 `sourceStrategy`
- 如果触发浏览器回退，会返回 `playwright:readability`、`playwright:selector:...`
- 若你只想使用纯 `fetch` 路径，可在调用时传 `playwrightFallback=false`
- 如果响应不是 HTML（例如 `application/json` / `application/pdf`），会返回结构化错误而不是继续盲目提取

### `extract_many`

批量提取多个 URL，逐条返回成功或失败结果。

输入：

- `urls`: URL 列表，最多 `20`
- `maxChars`: 最大输出字符数，默认 `30000`
- `timeoutMs`: 请求超时，默认 `25000`
- `playwrightFallback`: 是否允许自动浏览器回退，默认 `true`
- `concurrency`: 批量提取并发数，默认 `3`，最大 `8`

成功项结构：

- `ok`
- `url`
- `result`

失败项结构：

- `ok`
- `url`
- `error`
- `errorCode`
- `errorStage`
- `retryable`

当前内置的错误码包括：

- `FETCH_ERROR`
- `NON_HTML_RESPONSE`
- `EXTRACTION_ERROR`
- `PLAYWRIGHT_UNAVAILABLE`
- `PLAYWRIGHT_FALLBACK_FAILED`

## 开发脚本

```bash
npm run smoke
npm test
```

## 测试说明

- `npm test` 使用本地 HTML fixture，结果稳定，适合 CI
- `npm run smoke` 访问真实网页，用于人工冒烟验证
- 建议 smoke 时至少验证：
  - 一个普通 HTML 页面
  - 一个需要 fallback 的页面
  - 一个非 HTML 页面

## 限制

- 登录态页面、强交互页面、复杂验证码页面仍可能失败
- `playwright-core` 需要本机可用的 Chromium / Chrome / Edge 可执行文件
- 部分站点作者、发布时间等元数据可能缺失，但正文仍优先抽取
- 当前批量提取是“有限并发”而不是站点级调度，不适合高强度大规模采集

## 后续可扩展

- 增加域名级路由策略
- 增加更强的元数据提取规则
- 针对站点类型配置不同等待策略
- 增加 debug / verbose 模式
- 发布到 npm 或独立 GitHub 仓库
