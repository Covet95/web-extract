import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createExtractManyTool, createExtractUrlTool } from "./src/tools.ts";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createExtractUrlTool(api) as unknown as AnyAgentTool, { optional: true });
  api.registerTool(createExtractManyTool(api) as unknown as AnyAgentTool, { optional: true });
}
