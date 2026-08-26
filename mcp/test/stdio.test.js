import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = fileURLToPath(new URL("../src/server.js", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/movicom.js", import.meta.url));

test("basic stdio integration lists and calls tools without stdout pollution", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { ...process.env, MOVICOM_BIN: fixture },
    stderr: "pipe",
  });
  const client = new Client({ name: "movicom-mcp-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "android_devices"));

    const called = await client.callTool({ name: "android_devices", arguments: {} });
    assert.equal(called.isError, undefined);
    assert.deepEqual(JSON.parse(called.content[0].text), { devices: ["emulator-5554"] });
  } finally {
    await client.close();
  }
});
