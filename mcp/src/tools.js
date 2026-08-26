import { z } from "zod";

const device = z.string().min(1).optional().describe(
  "ADB serial from android_devices. Omit when exactly one device is connected.",
);

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const mutating = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const toolDefinitions = [
  {
    name: "android_status",
    description: "Check ADB, selected Android device, foreground app, and keyboard status. Start here.",
    inputSchema: { device },
    annotations: readOnly,
    command: () => ["doctor"],
  },
  {
    name: "android_devices",
    description: "List Android devices visible to ADB. Use a returned serial as device on other tools.",
    inputSchema: {},
    annotations: readOnly,
    command: () => ["devices"],
  },
  {
    name: "android_screen",
    description: "Read current screen as a compact structured Movicom frame. Prefer this over screenshots.",
    inputSchema: { device },
    annotations: readOnly,
    command: () => ["ui", "frame"],
  },
  {
    name: "android_action",
    description: "Run a numbered action from android_screen, or a stable verb such as type, send, up, down, back, home, or more. Returns resulting frame.",
    inputSchema: {
      action: z.union([z.number().int().positive(), z.string().min(1)]),
      text: z.string().optional().describe("Required when selected action types into a field."),
      device,
    },
    annotations: mutating,
    command: ({ action, text }) => ["ui", "do", JSON.stringify({ n: action, ...(text === undefined ? {} : { text }) })],
  },
  {
    name: "android_tap",
    description: "Tap a UI element by visible label. Prefer android_action after android_screen when possible.",
    inputSchema: { label: z.string().min(1), device },
    annotations: mutating,
    command: ({ label }) => ["ui", "tap", JSON.stringify({ label })],
  },
  {
    name: "android_fill",
    description: "Fill one or more labeled fields, resolving each field semantically instead of using coordinates.",
    inputSchema: {
      fields: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0, "At least one field is required"),
      device,
    },
    annotations: mutating,
    command: ({ fields }) => ["ui", "fill", JSON.stringify(fields)],
  },
  {
    name: "android_open_app",
    description: "Open an installed Android app by friendly name or package id.",
    inputSchema: { app: z.string().min(1), device },
    annotations: mutating,
    command: ({ app }) => ["app", "open", JSON.stringify({ name: app })],
  },
  {
    name: "android_fresh_app",
    description: "Force-stop, go home, then launch an app for a deterministic clean start.",
    inputSchema: { app: z.string().min(1), device },
    annotations: mutating,
    command: ({ app }) => ["app", "fresh", JSON.stringify({ name: app })],
  },
  {
    name: "android_list_apps",
    description: "List installed launchable Android apps with package ids.",
    inputSchema: { device },
    annotations: readOnly,
    command: () => ["app", "list"],
  },
  {
    name: "android_back",
    description: "Press Android Back and return resulting structured screen.",
    inputSchema: { device },
    annotations: mutating,
    command: () => ["ui", "back"],
  },
  {
    name: "android_home",
    description: "Press Android Home and return resulting structured screen.",
    inputSchema: { device },
    annotations: mutating,
    command: () => ["ui", "home"],
  },
  {
    name: "android_notifications",
    description: "Read Android notifications, optionally filtered by timestamp or app package substring.",
    inputSchema: {
      since: z.number().int().nonnegative().optional().describe("Only notifications at or after this epoch timestamp in milliseconds."),
      apps: z.array(z.string().min(1)).optional().describe("Package substrings to allow, such as whatsapp or gmail."),
      includeSystem: z.boolean().optional().default(false),
      device,
    },
    annotations: readOnly,
    command: ({ since, apps, includeSystem }) => [
      "notif",
      "list",
      JSON.stringify({ ...(since === undefined ? {} : { since }), ...(includeSystem ? { apps: [""] } : apps ? { apps } : {}) }),
    ],
  },
  {
    name: "android_contacts_list",
    description: "List Android contacts, optionally filtered by name or phone.",
    inputSchema: { filter: z.string().optional(), device },
    annotations: readOnly,
    command: ({ filter }) => ["contacts", "list", ...(filter ? [filter] : [])],
  },
  {
    name: "android_contacts_find",
    description: "Find Android contacts matching a name or phone query.",
    inputSchema: { query: z.string().min(1), device },
    annotations: readOnly,
    command: ({ query }) => ["contacts", "find", query],
  },
  {
    name: "android_web_open",
    description: "Open a URL or domain directly through an Android VIEW intent and return page structure.",
    inputSchema: { url: z.string().min(1), device },
    annotations: mutating,
    command: ({ url }) => ["web", "open", url],
  },
  {
    name: "android_web_search",
    description: "Open Android browser search results for a query and return page structure.",
    inputSchema: { query: z.string().min(1), device },
    annotations: mutating,
    command: ({ query }) => ["web", "search", query],
  },
  {
    name: "android_screenshot",
    description: "Capture current Android screen as image content. Fallback only when android_screen lacks enough information.",
    inputSchema: { device },
    annotations: readOnly,
    image: "screenshot",
    command: (_input, runtime) => ["ui", "shot", runtime.file],
  },
  {
    name: "android_camera_shot",
    description: "Take a real camera photo. This changes device state and may expose sensitive surroundings; obtain user confirmation first.",
    inputSchema: {
      returnImage: z.boolean().optional().default(true).describe("Return captured photo as MCP image content."),
      device,
    },
    annotations: mutating,
    image: "camera",
    command: ({ returnImage }, runtime) => [
      "camera",
      "shot",
      JSON.stringify({ pull: returnImage, ...(returnImage ? { dir: runtime.dir } : {}) }),
    ],
  },
];

export function getTool(name) {
  return toolDefinitions.find((tool) => tool.name === name);
}
