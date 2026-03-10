import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { extractMany, extractUrl } from "../extractor.js";

type PluginDefaults = {
  maxChars?: number;
  timeoutMs?: number;
  playwrightFallback?: boolean;
  concurrency?: number;
  debug?: boolean;
};

type PluginConfig = {
  defaults?: PluginDefaults;
};

function getDefaults(api: OpenClawPluginApi): PluginDefaults {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  return cfg.defaults ?? {};
}

function toTextResult(payload: unknown, details?: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details,
  };
}

export function createExtractUrlTool(api: OpenClawPluginApi) {
  return {
    name: "web_extract_url",
    label: "Web Extract URL",
    description:
      "Extract a public webpage into structured Markdown/text using the local web-extract engine.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "Target webpage URL." },
        maxChars: {
          type: "number",
          minimum: 1000,
          maximum: 120000,
          description: "Maximum content chars.",
        },
        timeoutMs: {
          type: "number",
          minimum: 3000,
          maximum: 120000,
          description: "Fetch timeout in ms.",
        },
        playwrightFallback: {
          type: "boolean",
          description: "Allow Playwright fallback when extraction looks incomplete.",
        },
        debug: {
          type: "boolean",
          description: "Include structured debug diagnostics in the result.",
        },
      },
      required: ["url"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const defaults = getDefaults(api);
      const url = typeof params.url === "string" ? params.url.trim() : "";
      if (!url) {
        throw new Error("url required");
      }

      const result = await extractUrl(url, {
        maxChars: typeof params.maxChars === "number" ? params.maxChars : defaults.maxChars,
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : defaults.timeoutMs,
        playwrightFallback:
          typeof params.playwrightFallback === "boolean"
            ? params.playwrightFallback
            : defaults.playwrightFallback,
        debug: typeof params.debug === "boolean" ? params.debug : defaults.debug,
      });

      if (api.logger?.debug) {
        api.logger.debug(`web_extract_url ok url=${url} strategy=${String(result.sourceStrategy ?? "")}`);
      }

      return toTextResult(result, result);
    },
  };
}

export function createExtractManyTool(api: OpenClawPluginApi) {
  return {
    name: "web_extract_many",
    label: "Web Extract Many",
    description:
      "Extract multiple public webpages into structured Markdown/text using the local web-extract engine.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        urls: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description: "List of target URLs.",
          items: { type: "string", description: "Target webpage URL." },
        },
        maxChars: {
          type: "number",
          minimum: 1000,
          maximum: 120000,
          description: "Maximum content chars.",
        },
        timeoutMs: {
          type: "number",
          minimum: 3000,
          maximum: 120000,
          description: "Fetch timeout in ms.",
        },
        playwrightFallback: {
          type: "boolean",
          description: "Allow Playwright fallback when extraction looks incomplete.",
        },
        concurrency: {
          type: "number",
          minimum: 1,
          maximum: 8,
          description: "Batch concurrency.",
        },
        debug: {
          type: "boolean",
          description: "Include structured debug diagnostics in successful items.",
        },
      },
      required: ["urls"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const defaults = getDefaults(api);
      const urls = Array.isArray(params.urls)
        ? params.urls.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        : [];
      if (urls.length === 0) {
        throw new Error("urls required");
      }

      const items = await extractMany(urls, {
        maxChars: typeof params.maxChars === "number" ? params.maxChars : defaults.maxChars,
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : defaults.timeoutMs,
        playwrightFallback:
          typeof params.playwrightFallback === "boolean"
            ? params.playwrightFallback
            : defaults.playwrightFallback,
        concurrency:
          typeof params.concurrency === "number" ? params.concurrency : defaults.concurrency,
        debug: typeof params.debug === "boolean" ? params.debug : defaults.debug,
      });

      if (api.logger?.debug) {
        api.logger.debug(`web_extract_many ok count=${urls.length}`);
      }

      return toTextResult({ items }, { items });
    },
  };
}
