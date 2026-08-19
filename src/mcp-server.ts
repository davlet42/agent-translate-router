#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.js";
import { translateDocument, translateText } from "./router.js";
import type { HostId, TranslationDirection } from "./types.js";

let versionPromise: Promise<string> | undefined;

async function packageVersion(): Promise<string> {
  versionPromise ??= readFile(new URL("../package.json", import.meta.url), "utf8")
    .then((raw) => (JSON.parse(raw) as { version?: string }).version ?? "unknown")
    .catch(() => "unknown");
  return versionPromise;
}

const TOOLS = [
  {
    name: "translate",
    description: "Translate RU↔EN through the configured cross-provider policy. Uses local provider CLIs and subscription auth; never calls a provider API directly.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to translate" },
        direction: { type: "string", enum: ["ru_en", "en_ru"], default: "ru_en" },
        project_slug: { type: "string" },
        host: { type: "string", enum: ["codex", "agy", "cursor", "claude", "unknown"] },
      },
      required: ["text"],
    },
  },
  {
    name: "resolve_doc",
    description: "Resolve a Markdown document to a complete English translation using the shared sibling caches and the configured provider cascade.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Relative or absolute Markdown path" },
        project_slug: { type: "string" },
        include_body: { type: "boolean", default: false },
      },
      required: ["file_path"],
    },
  },
];

function textResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export async function handleMcpRequest(request: Record<string, unknown>, config?: Awaited<ReturnType<typeof loadConfig>>): Promise<Record<string, unknown> | null> {
  const activeConfig = config ?? await loadConfig();
  const version = await packageVersion();
  const id = request.id;
  if (request.method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "agent-translate-router", version }, capabilities: { tools: {} } } };
  }
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return null;
  if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (request.method !== "tools/call") return null;

  const params = (request.params && typeof request.params === "object" ? request.params : {}) as Record<string, unknown>;
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
  try {
    if (name === "translate") {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) return { jsonrpc: "2.0", id, result: textResult({ text, complete: false, failOpen: true, reason: "text is required" }) };
      const direction: TranslationDirection = args.direction === "en_ru" ? "en_ru" : "ru_en";
      const host = typeof args.host === "string" ? args.host as HostId : undefined;
      const result = await translateText(text, activeConfig, { direction, host, projectSlug: typeof args.project_slug === "string" ? args.project_slug : undefined, event: "prompt" });
      return { jsonrpc: "2.0", id, result: textResult({ ...result, failOpen: !result.complete, direction }) };
    }
    if (name === "resolve_doc") {
      const sourcePath = typeof args.file_path === "string" ? resolve(args.file_path) : "";
      if (!sourcePath) return { jsonrpc: "2.0", id, result: textResult({ sourcePath, readPath: sourcePath, complete: false, failOpen: true, reason: "file_path is required" }) };
      const result = await translateDocument(sourcePath, activeConfig, { cwd: dirname(sourcePath), projectSlug: typeof args.project_slug === "string" ? args.project_slug : undefined, event: "document" });
      const readPath = result.complete && result.cachePath ? result.cachePath : sourcePath;
      const body = args.include_body === true ? (result.complete ? result.text : await readFile(sourcePath, "utf8")) : undefined;
      return { jsonrpc: "2.0", id, result: textResult({ sourcePath, readPath, cachePath: result.cachePath ?? null, complete: result.complete, failOpen: !result.complete, provider: result.provider, model: result.model, segments: result.segments, translatedSegments: result.translatedSegments, ...(body === undefined ? {} : { body }) }) };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } };
  } catch (error) {
    if (name === "translate") return { jsonrpc: "2.0", id, result: textResult({ text: args.text ?? "", complete: false, failOpen: true, reason: "fail_open" }) };
    return { jsonrpc: "2.0", id, result: textResult({ sourcePath: args.file_path ?? "", readPath: args.file_path ?? "", complete: false, failOpen: true, reason: "fail_open" }) };
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as Record<string, unknown>;
      const response = await handleMcpRequest(request, config);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } }) + "\n");
    }
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
