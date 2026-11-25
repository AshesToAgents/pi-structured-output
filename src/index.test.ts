import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import structuredOutput, { activateStructuredOutput } from "./index.js";

type Handler = (event: any, ctx: any) => unknown;

interface FakeExtension {
  flags: Map<string, unknown>;
  tools: Map<string, ToolDefinition>;
  activeTools: string[];
  setActiveToolsCalls: string[][];
  handlers: Map<string, Handler[]>;
  api: ExtensionAPI;
  emit(type: string, event: unknown, ctx?: Partial<ExtensionContext>): Promise<unknown[]>;
}

function fakeExtension(): FakeExtension {
  const extension: FakeExtension = {
    flags: new Map(),
    tools: new Map(),
    activeTools: [],
    setActiveToolsCalls: [],
    handlers: new Map(),
    api: undefined as never,
    async emit(type, event, ctx = {}) {
      const handlers = extension.handlers.get(type) ?? [];
      const results: unknown[] = [];
      for (const handler of handlers) {
        results.push(await handler(event, ctx));
      }
      return results;
    },
  };
  // Loosely typed on purpose: only the members the extension uses are faked.
  const api: Record<string, (...args: any[]) => unknown> = {
    registerFlag(name: string, options: { default?: unknown }) {
      extension.flags.set(name, options.default);
    },
    getFlag(name: string) {
      return extension.flags.get(name);
    },
    on(type: string, handler: Handler) {
      const handlers = extension.handlers.get(type) ?? [];
      handlers.push(handler);
      extension.handlers.set(type, handlers);
      return () => {};
    },
    registerTool(tool: ToolDefinition) {
      extension.tools.set(tool.name, tool);
      extension.activeTools.push(tool.name);
    },
    getActiveTools() {
      return [...extension.activeTools];
    },
    setActiveTools(names: string[]) {
      extension.setActiveToolsCalls.push(names);
      extension.activeTools = [...names];
    },
  };
  extension.api = api as unknown as ExtensionAPI;
  return extension;
}

interface Harness {
  fake: FakeExtension;
  outputs: string[];
  errors: string[];
  exitCodes: number[];
  exits: number[];
  ctx: Partial<ExtensionContext>;
  startRun(): Promise<void>;
  assistantMessage(parts: Record<string, unknown>): AssistantMessage;
  submit(params: Record<string, unknown>): Promise<unknown>;
  beforeSettle(outcome?: AgentBeforeSettleEvent["outcome"]): Promise<unknown[]>;
  settle(aborted?: boolean): Promise<void>;
}

const SCHEMA = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["approve", "reject"] } },
};

const REVIEW = { verdict: "approve" };

function harness(options: { mode?: ExtensionContext["mode"]; maxRetries?: number } = {}): Harness {
  const fake = fakeExtension();
  const outputs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const exits: number[] = [];
  const ctx: Partial<ExtensionContext> = { mode: options.mode ?? "print" };
  activateStructuredOutput(fake.api, {
    schema: SCHEMA,
    mode: options.mode ?? "print",
    maxRetries: options.maxRetries,
    writeOutput: (text) => {
      outputs.push(text);
    },
    writeError: (text) => {
      errors.push(text);
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  const tool = () => fake.tools.get("submit_output")!;
  return {
    fake,
    outputs,
    errors,
    exitCodes,
    exits,
    ctx,
    startRun: () =>
      fake
        .emit(
          "before_agent_start",
          { type: "before_agent_start", messageType: "user", prompt: "go", images: [], systemPrompt: "" },
          ctx,
        )
        .then(() => undefined),
    assistantMessage(parts) {
      return { role: "assistant", content: [], usage: {}, stopReason: "stop", ...parts } as unknown as AssistantMessage;
    },
    submit: (params) =>
      tool().execute("call-1", params, undefined, undefined, ctx as ExtensionToolContext),
    beforeSettle: (outcome = "completed") =>
      fake.emit(
        "agent_before_settle",
        { type: "agent_before_settle", entries: [], continue: false, outcome, context: {} },
        ctx,
      ),
    settle: async (aborted = false) => {
      await fake.emit("agent_settled", { type: "agent_settled", aborted }, ctx);
    },
  };
}

describe("activateStructuredOutput", () => {
  it("registers submit_output with the schema as its parameters", () => {
    const { fake } = harness();
    const tool = fake.tools.get("submit_output");
    expect(tool?.parameters).toEqual(SCHEMA);
    expect(tool?.promptGuidelines?.join("\n")).toMatch(/submit_output/);
    expect(tool?.description).toMatch(/final/);
  });

  it("re-activates submit_output when the tool selection disabled it", async () => {
    const h = harness();
    h.fake.activeTools.length = 0; // as `--no-tools` or a `--tools` allowlist would
    await h.startRun();
    expect(h.fake.setActiveToolsCalls).toEqual([["submit_output"]]);
    expect(h.fake.activeTools).toEqual(["submit_output"]);
  });

  it("fails fast when the tool selection keeps submit_output out of the registry", async () => {
    const h = harness();
    // Pi drops tools outside an empty `--tools`/`--no-tools` allowlist when they register, so
    // setActiveTools cannot bring this one back.
    (h.fake.api as unknown as { setActiveTools: () => void }).setActiveTools = () => {};
    h.fake.activeTools.length = 0;
    await h.startRun();
    expect(h.exits).toEqual([2]);
    expect(h.errors.join("\n")).toMatch(/--no-tools/);
    expect(h.errors.join("\n")).toMatch(/--tools submit_output/);
  });

  it("leaves the tool selection alone when submit_output is already active", async () => {
    const h = harness();
    h.fake.activeTools.push("read");
    await h.startRun();
    expect(h.fake.setActiveToolsCalls).toEqual([]);
  });

  it("writes the submitted arguments as one compact JSON line and terminates", async () => {
    const h = harness();
    await h.startRun();
    const result = (await h.submit(REVIEW)) as { terminate?: boolean; isError?: boolean };
    expect(result.terminate).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(h.outputs).toEqual([JSON.stringify(REVIEW) + "\n"]);
  });

  it("writes output only once per run", async () => {
    const h = harness();
    await h.startRun();
    await h.submit(REVIEW);
    const second = (await h.submit({ verdict: "reject" })) as { isError?: boolean };
    expect(second.isError).toBe(true);
    expect(h.outputs).toEqual([JSON.stringify(REVIEW) + "\n"]);
  });

  it("writes output again for the next prompt", async () => {
    const h = harness();
    await h.startRun();
    await h.submit(REVIEW);
    await h.settle();
    await h.startRun();
    await h.submit({ verdict: "reject" });
    expect(h.outputs).toEqual([JSON.stringify(REVIEW) + "\n", JSON.stringify({ verdict: "reject" }) + "\n"]);
  });

  it("asks the model to submit when a run ends without a submission", async () => {
    const h = harness();
    await h.startRun();
    const [result] = (await h.beforeSettle()) as [{ entries?: unknown[]; continue?: boolean }];
    expect(result.continue).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries?.[0]).toMatchObject({ type: "custom_message", content: expect.stringContaining("submit_output") });
  });

  it("counts retries across the whole prompt, not per low-level run", async () => {
    // Each requested continuation starts a new low-level run (agent_start fires again).
    const h = harness({ maxRetries: 2 });
    await h.startRun();
    const [first] = await h.beforeSettle();
    await h.fake.emit("agent_start", { type: "agent_start" }, h.ctx);
    const [second] = await h.beforeSettle();
    await h.fake.emit("agent_start", { type: "agent_start" }, h.ctx);
    const [third] = await h.beforeSettle();
    expect(first).toMatchObject({ continue: true });
    expect(second).toMatchObject({ continue: true });
    expect(third).toBeUndefined();
  });

  it("stops asking after maxRetries", async () => {
    const h = harness({ maxRetries: 2 });
    await h.startRun();
    const [first, second, third] = [
      (await h.beforeSettle())[0],
      (await h.beforeSettle())[0],
      (await h.beforeSettle())[0],
    ] as unknown as [{ continue?: boolean }, { continue?: boolean }, unknown];
    expect(first.continue).toBe(true);
    expect(second.continue).toBe(true);
    expect(third).toBeUndefined();
  });

  it("does not ask again once a submission was made", async () => {
    const h = harness();
    await h.startRun();
    await h.submit(REVIEW);
    expect(await h.beforeSettle()).toEqual([undefined]);
  });

  it("does not retry a run that ended in an error or was aborted", async () => {
    const h = harness();
    await h.startRun();
    expect(await h.beforeSettle("error")).toEqual([undefined]);
    expect(await h.beforeSettle("aborted")).toEqual([undefined]);
  });

  it("reports failure and sets a non-zero exit code when no submission arrived", async () => {
    const h = harness({ maxRetries: 1 });
    await h.startRun();
    await h.beforeSettle();
    await h.beforeSettle();
    await h.settle();
    expect(h.outputs).toEqual([]);
    expect(h.exitCodes).toEqual([1]);
    expect(h.errors.join("\n")).toMatch(/submit_output/);
  });

  it("does not report failure for a run that was aborted", async () => {
    const h = harness();
    await h.startRun();
    await h.settle(true);
    expect(h.errors).toEqual([]);
    expect(h.exitCodes).toEqual([]);
  });

  it("does not report failure for a run that submitted", async () => {
    const h = harness();
    await h.startRun();
    await h.submit(REVIEW);
    await h.settle();
    expect(h.errors).toEqual([]);
    expect(h.exitCodes).toEqual([]);
  });

  it("includes the model's final text in the failure report", async () => {
    const h = harness({ maxRetries: 0 });
    await h.startRun();
    await h.fake.emit("message_end", { type: "message_end", message: h.assistantMessage({ content: [{ type: "text", text: "Looks good." }] }) }, h.ctx);
    await h.settle();
    expect(h.errors.join("\n")).toMatch(/Looks good\./);
  });

  it("strips text from assistant messages in print mode but keeps thinking and tool calls", async () => {
    const h = harness();
    const toolCall = { type: "toolCall", id: "t1", name: "read", arguments: {} };
    const thinking = { type: "thinking", thinking: "hmm" };
    const message = h.assistantMessage({ content: [{ type: "text", text: "Prose" }, thinking, toolCall] });
    const [result] = (await h.fake.emit("message_end", { type: "message_end", message }, h.ctx)) as [
      { message: AssistantMessage },
    ];
    expect(result.message.role).toBe("assistant");
    expect(result.message.content).toEqual([thinking, toolCall]);
  });

  it("leaves non-assistant messages alone", async () => {
    const h = harness();
    const message = { role: "user", content: [{ type: "text", text: "hi" }] } as AgentMessage;
    expect(await h.fake.emit("message_end", { type: "message_end", message }, h.ctx)).toEqual([undefined]);
  });

  it("does not write to stdout or strip text outside print mode", async () => {
    const h = harness({ mode: "tui" });
    await h.startRun();
    await h.submit(REVIEW);
    const message = h.assistantMessage({ content: [{ type: "text", text: "Prose" }] });
    expect(await h.fake.emit("message_end", { type: "message_end", message }, h.ctx)).toEqual([undefined]);
    expect(h.outputs).toEqual([]);
  });
});

describe("default export", () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length > 0) {
      rmSync(directories.pop()!, { recursive: true, force: true });
    }
  });

  function schemaFile(schema: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), "pi-structured-output-"));
    directories.push(directory);
    const path = join(directory, "schema.json");
    writeFileSync(path, JSON.stringify(schema), "utf8");
    return path;
  }

  it("registers the --output-schema flag", () => {
    const fake = fakeExtension();
    structuredOutput(fake.api);
    expect(fake.flags.get("output-schema")).toBe("");
  });

  it("does nothing when the flag is not set", async () => {
    const fake = fakeExtension();
    structuredOutput(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "print", cwd: tmpdir() });
    expect(fake.tools.size).toBe(0);
  });

  it("activates with the schema from the flag file", async () => {
    const fake = fakeExtension();
    structuredOutput(fake.api);
    fake.flags.set("output-schema", schemaFile(SCHEMA));
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "print", cwd: tmpdir() });
    expect(fake.tools.get("submit_output")?.parameters).toEqual(SCHEMA);
  });

  it("exits with an error when the schema cannot be loaded", async () => {
    const fake = fakeExtension();
    const errors: string[] = [];
    const exits: number[] = [];
    structuredOutput(fake.api, { writeError: (text) => errors.push(text), exit: (code) => exits.push(code) });
    fake.flags.set("output-schema", join(tmpdir(), "missing.json"));
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "print", cwd: tmpdir() });
    expect(exits).toEqual([2]);
    expect(errors.join("\n")).toMatch(/--output-schema/);
    expect(fake.tools.size).toBe(0);
  });
});
