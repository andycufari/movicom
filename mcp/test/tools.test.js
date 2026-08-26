import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { getTool, toolDefinitions } from "../src/tools.js";

test("tool names are unique and schemas compile", () => {
  const names = toolDefinitions.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of toolDefinitions) {
    assert.doesNotThrow(() => z.object(tool.inputSchema));
  }
});

test("required semantic tool surface exists", () => {
  const names = new Set(toolDefinitions.map((tool) => tool.name));
  for (const name of [
    "android_status", "android_devices", "android_screen", "android_action",
    "android_tap", "android_fill", "android_open_app", "android_fresh_app",
    "android_list_apps", "android_back", "android_home", "android_notifications",
    "android_contacts_list", "android_contacts_find", "android_web_open",
    "android_web_search", "android_camera_shot",
  ]) assert.ok(names.has(name), `missing ${name}`);
});

test("translates MCP inputs into existing Movicom commands", () => {
  assert.deepEqual(getTool("android_screen").command({}), ["ui", "frame"]);
  assert.deepEqual(
    getTool("android_action").command({ action: 2, text: "hello" }),
    ["ui", "do", '{"n":2,"text":"hello"}'],
  );
  assert.deepEqual(
    getTool("android_fill").command({ fields: { Email: "a@example.com" } }),
    ["ui", "fill", '{"Email":"a@example.com"}'],
  );
  assert.deepEqual(
    getTool("android_fresh_app").command({ app: "settings" }),
    ["app", "fresh", '{"name":"settings"}'],
  );
});

test("schemas reject invalid actions and empty form maps", () => {
  const actionSchema = z.object(getTool("android_action").inputSchema);
  assert.equal(actionSchema.safeParse({ action: 0 }).success, false);
  assert.equal(actionSchema.safeParse({ action: 1 }).success, true);

  const fillSchema = z.object(getTool("android_fill").inputSchema);
  assert.equal(fillSchema.safeParse({ fields: {} }).success, false);
});
