# openclaw-plugin

给 `web-extract` 提供一个 OpenClaw 原生插件包装层。

## 暴露的工具

- `web_extract_url`
- `web_extract_many`

之所以用了带前缀的工具名，而不是直接沿用 `extract_url` / `extract_many`，是为了减少和其他插件 / 核心工具撞名的风险。

## 设计原则

- **复用现有核心逻辑**：直接调用上层仓库里的 `extractor.js`
- **不重写提取器**：这里只负责 OpenClaw `registerTool` 包装
- **可选启用**：两个工具都注册为 optional

## 建议安装方式

把这个目录当作一个本地 OpenClaw plugin 安装，例如：

```bash
openclaw plugins install /absolute/path/to/web-extract/openclaw-plugin
```

安装后按需启用，并把工具加入 agent allowlist。

## 可配默认值

插件 manifest 里预留了 `defaults`：

- `maxChars`
- `timeoutMs`
- `playwrightFallback`
- `concurrency`
- `debug`

这些默认值用于 OpenClaw tool 调用时的缺省参数。
