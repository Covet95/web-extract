#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { extractMany, extractUrl } from './extractor.js';

const debugSchema = z.object({
  fetch: z.object({}).catchall(z.any()),
  extraction: z.object({}).catchall(z.any()),
  fallback: z.object({}).catchall(z.any()),
});

const server = new McpServer(
  {
    name: 'web-extract',
    version: '0.1.0',
  },
  {
    capabilities: {
      logging: {},
    },
  },
);

server.registerTool(
  'extract_url',
  {
    description: '提取单个网页正文并输出为结构化 Markdown，适合文章总结、信息抽取和喂给 LLM。',
    inputSchema: {
      url: z.url().describe('要提取的网页 URL'),
      maxChars: z.number().int().min(1000).max(120000).default(30000).describe('正文最大字符数，默认 30000'),
      timeoutMs: z.number().int().min(3000).max(120000).default(25000).describe('请求超时时间，毫秒'),
      playwrightFallback: z.boolean().default(true).describe('提取失败或命中回退规则时，是否自动使用 Playwright 回退'),
      debug: z.boolean().default(false).describe('是否返回调试诊断信息，默认 false'),
    },
    outputSchema: {
      url: z.string(),
      finalUrl: z.string(),
      status: z.number(),
      title: z.string(),
      author: z.string(),
      publishedAt: z.string(),
      sourceStrategy: z.string(),
      markdown: z.string(),
      plainText: z.string(),
      excerpt: z.string(),
      images: z.array(z.string()),
      contentLength: z.number(),
      warnings: z.array(z.string()),
      debug: debugSchema.optional(),
    },
  },
  async ({ url, maxChars, timeoutMs, playwrightFallback, debug }) => {
    const structuredContent = await extractUrl(url, { maxChars, timeoutMs, playwrightFallback, debug });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
    };
  },
);

server.registerTool(
  'extract_many',
  {
    description: '批量提取多个网页正文，逐条返回结果。',
    inputSchema: {
      urls: z.array(z.url()).min(1).max(20).describe('要批量提取的 URL 列表'),
      maxChars: z.number().int().min(1000).max(120000).default(30000).describe('正文最大字符数，默认 30000'),
      timeoutMs: z.number().int().min(3000).max(120000).default(25000).describe('请求超时时间，毫秒'),
      playwrightFallback: z.boolean().default(true).describe('提取失败或命中回退规则时，是否自动使用 Playwright 回退'),
      concurrency: z.number().int().min(1).max(8).default(3).describe('批量提取并发数，默认 3'),
      debug: z.boolean().default(false).describe('是否在成功项中返回调试诊断信息，默认 false'),
    },
    outputSchema: {
      items: z.array(z.object({
        ok: z.boolean(),
        url: z.string(),
        result: z.object({
          url: z.string(),
          finalUrl: z.string(),
          status: z.number(),
          title: z.string(),
          author: z.string(),
          publishedAt: z.string(),
          sourceStrategy: z.string(),
          markdown: z.string(),
          plainText: z.string(),
          excerpt: z.string(),
          images: z.array(z.string()),
          contentLength: z.number(),
          warnings: z.array(z.string()),
          debug: debugSchema.optional(),
        }).optional(),
        error: z.string().optional(),
        errorCode: z.string().optional(),
        errorStage: z.string().optional(),
        retryable: z.boolean().optional(),
      })),
    },
  },
  async ({ urls, maxChars, timeoutMs, playwrightFallback, concurrency, debug }) => {
    const items = await extractMany(urls, { maxChars, timeoutMs, playwrightFallback, concurrency, debug });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ items }, null, 2),
        },
      ],
      structuredContent: { items },
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('web-extract MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in web-extract MCP server:', error);
  process.exit(1);
});
