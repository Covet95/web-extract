# openclaw-plugin

给 `web-extract` 提供一个 **OpenClaw 原生插件**包装层（非 MCP）。

> 说明：这个插件目录是**可独立安装**的。为避免安装后找不到上层仓库文件，插件内包含一份 `extractor.js` 提取引擎（来自仓库根目录）。

## 暴露的工具

- `web_extract_url`
- `web_extract_many`

之所以用了带前缀的工具名，而不是直接沿用 `extract_url` / `extract_many`，是为了减少和其他插件 / 核心工具撞名的风险。

## 设计原则

- **复用现有核心逻辑**：插件内的 `extractor.js` 就是提取引擎
- **不重写提取器**：这里只负责 OpenClaw `registerTool` 包装
- **可选启用**：两个工具都注册为 optional（默认不启用，需加入 allowlist）

## 建议安装方式（本地开发 / 开源可复现）

在仓库根目录执行：

```bash
# 开发建议用 link（不拷贝）
openclaw plugins install -l /absolute/path/to/web-extract/openclaw-plugin

# 或者用 copy 安装到 ~/.openclaw/extensions/<id>
openclaw plugins install /absolute/path/to/web-extract/openclaw-plugin

# 查看与自检
openclaw plugins list
openclaw plugins info web-extract
openclaw plugins doctor
```

安装后 **重启 Gateway**（配置变更需要重启）：

```bash
openclaw gateway restart
```

## 启用工具（可选工具需要 allowlist）

本插件两个工具是 `optional: true`，必须显式允许。

可以用两种方式之一：

### 方式 A：在某个 agent 上启用（推荐）

在 `openclaw.json` 里给你的 agent 加：

```json5
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "web_extract_url",
            "web_extract_many"
          ]
        }
      }
    ]
  }
}
```

### 方式 B：全局启用

```json5
{ "tools": { "allow": ["web_extract_url", "web_extract_many"] } }
```

> 注意：如果你在用严格 allowlist（只允许少数工具），记得把你仍然要用的核心工具/组也一起允许。

## 可配默认值

插件 manifest 里预留了 `defaults`，会作为工具参数的缺省值：

- `maxChars`
- `timeoutMs`
- `playwrightFallback`
- `concurrency`
- `debug`

示例（写到 `openclaw.json` 的 `plugins.entries.web-extract.config` 下）：

```json5
{
  "plugins": {
    "entries": {
      "web-extract": {
        "enabled": true,
        "config": {
          "defaults": {
            "maxChars": 30000,
            "timeoutMs": 25000,
            "playwrightFallback": true,
            "concurrency": 3,
            "debug": false
          }
        }
      }
    }
  }
}
```

## 调用参数速查

- `web_extract_url`: `{ url, maxChars?, timeoutMs?, playwrightFallback?, debug? }`
- `web_extract_many`: `{ urls, maxChars?, timeoutMs?, playwrightFallback?, concurrency?, debug? }`

## 开源审查备注

- 仓库为 MIT License。
- 插件不包含任何账号/密钥；仅使用公开网页 URL。
