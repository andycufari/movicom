#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MovicomError, runMovicom } from "./runner.js";
import { toolDefinitions } from "./tools.js";

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(error) {
  const body = error instanceof MovicomError
    ? { error: error.message, code: error.code, technical: error.technical }
    : { error: "Movicom MCP failed", code: "INTERNAL_ERROR", technical: { cause: error.message } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

function mimeType(file) {
  const ext = extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

export async function executeTool(definition, input, options = {}) {
  let tempDir;
  try {
    const runtime = {};
    if (definition.image) {
      tempDir = await mkdtemp(join(tmpdir(), "movicom-mcp-"));
      runtime.dir = tempDir;
      runtime.file = join(tempDir, "screen.png");
    }
    const result = await runMovicom(definition.command(input, runtime), {
      ...options,
      device: input.device,
    });

    if (definition.image === "screenshot") {
      const data = await readFile(result.shot || runtime.file);
      return {
        content: [
          { type: "text", text: JSON.stringify({ captured: true, kind: "screenshot" }) },
          { type: "image", data: data.toString("base64"), mimeType: "image/png" },
        ],
      };
    }

    if (definition.image === "camera" && input.returnImage && result.pulled) {
      const data = await readFile(result.pulled);
      return {
        content: [
          { type: "text", text: JSON.stringify({ photo: result.photo }) },
          { type: "image", data: data.toString("base64"), mimeType: mimeType(result.pulled) },
        ],
      };
    }
    return textResult(result);
  } catch (error) {
    return errorResult(error);
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

export function createServer(options = {}) {
  const server = new McpServer({ name: "movicom-mcp", version: "0.1.0" });
  for (const definition of toolDefinitions) {
    server.registerTool(definition.name, {
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: definition.annotations,
    }, (input) => executeTool(definition, input, options));
  }
  return server;
}

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`[movicom-mcp] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
