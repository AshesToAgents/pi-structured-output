import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { loadOutputSchema, type OutputSchema } from "./schema.js";
import { writeToStdout } from "./stdout.js";

export const OUTPUT_SCHEMA_FLAG = "output-schema";
export const SUBMIT_TOOL_NAME = "submit_output";
const DEFAULT_MAX_RETRIES = 2;
const RETRY_CUSTOM_TYPE = "structured-output-retry";

const RETRY_MESSAGE =
  `The run ended without a ${SUBMIT_TOOL_NAME} call. Call ${SUBMIT_TOOL_NAME} now with the final ` +
  `answer, as the only tool call in this response. Do not reply with text.`;

/** Side effects the extension has beyond Pi's API, injectable for tests. */
export interface StructuredOutputIo {
  /** Writes machine-readable output (stdout in print mode). May return a promise that resolves once flushed. */
  writeOutput: (text: string) => void | Promise<void>;
  /** Writes human-readable diagnostics (stderr). */
  writeError: (text: string) => void;
  /** Records the process exit code without terminating. */
  setExitCode: (code: number) => void;
  /** Terminates the process immediately. */
  exit: (code: number) => void;
}

export interface StructuredOutputOptions extends StructuredOutputIo {
  schema: OutputSchema;
  mode: ExtensionContext["mode"];
  /** How many times the model may be asked again to call the tool when a run ends without it. */
  maxRetries?: number;
}

interface SubmitDetails {
  output: unknown;
}

interface RunState {
  submitted: boolean;
  retries: number;
  lastAssistantText: string;
}

function newRun(): RunState {
  return { submitted: false, retries: 0, lastAssistantText: "" };
}

/**
 * Register the submit tool and the handlers that keep stdout to schema-conforming JSON in print
 * mode. Returns a function that removes everything it registered.
 */
export function activateStructuredOutput(pi: ExtensionAPI, options: StructuredOutputOptions): () => void {
  const { schema, mode } = options;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const writesToStdout = mode === "print";
  let run = newRun();
  const unsubscribe: Array<() => void> = [];

  pi.registerTool({
    name: SUBMIT_TOOL_NAME,
    label: "Submit output",
    description:
      "Submit the final answer for this run. Call it exactly once, as your last action, instead of " +
      "writing a prose answer. The arguments must conform to the tool's parameter schema.",
    promptSnippet: "Submit the final answer as structured output conforming to the given schema",
    promptGuidelines: [
      `End every run by calling ${SUBMIT_TOOL_NAME} with the final answer; the run ends on that call.`,
      "Use other tools as needed before calling it, but never answer in prose instead of calling it.",
      `Call ${SUBMIT_TOOL_NAME} on its own: never together with other tools in the same response.`,
    ],
    parameters: schema as TSchema,

    async execute(_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: SubmitDetails; terminate?: boolean; isError?: boolean }> {
      if (run.submitted) {
        return {
          content: [{ type: "text", text: `Output was already submitted for this run; ignoring this call.` }],
          details: { output: null },
          isError: true,
        };
      }
      run.submitted = true;
      if (writesToStdout) {
        await options.writeOutput(`${JSON.stringify(params)}\n`);
      }
      return {
        content: [{ type: "text", text: "Output received. The run ends here." }],
        details: { output: params },
        terminate: true,
      };
    },
  });

  // One prompt is one attempt at a structured answer. A continuation requested from
  // agent_before_settle starts a new low-level run (agent_start fires again), so the per-prompt
  // state must reset here rather than on agent_start.
  unsubscribe.push(
    pi.on("before_agent_start", async () => {
      run = newRun();
      // `--no-tools` and `--tools` allowlists run before this extension registers the tool, so an
      // explicit --output-schema must re-activate it or the model has no way to answer.
      const active = pi.getActiveTools();
      if (!active.includes(SUBMIT_TOOL_NAME)) {
        pi.setActiveTools([...active, SUBMIT_TOOL_NAME]);
      }
      // An empty allowlist (`--no-tools`, or `--tools` without the tool) drops the tool when it
      // registers, so it cannot be activated; the model would have no way to answer.
      if (!pi.getActiveTools().includes(SUBMIT_TOOL_NAME)) {
        options.writeError(
          `pi-structured-output: ${SUBMIT_TOOL_NAME} is disabled by the tool selection ` +
            `(--no-tools or a --tools allowlist without it). Use --tools ${SUBMIT_TOOL_NAME} for a ` +
            `run without other tools.\n`,
        );
        options.exit(2);
      }
    }),
  );

  // Print mode echoes the last assistant message's text to stdout. In schema mode the output is
  // the tool call, so assistant text would only pollute stdout; drop it, keeping thinking and tool calls.
  unsubscribe.push(
    pi.on("message_end", async (event) => {
      if (!writesToStdout || event.message.role !== "assistant") return;
      const message = event.message;
      const kept = message.content.filter((part) => part.type !== "text");
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("\n")
        .trim();
      if (text) run.lastAssistantText = text;
      if (kept.length === message.content.length) return;
      return { message: { ...message, content: kept } };
    }),
  );

  unsubscribe.push(
    pi.on("agent_before_settle", async (event) => {
      if (run.submitted || event.outcome !== "completed" || run.retries >= maxRetries) return;
      run.retries += 1;
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message" as const,
            customType: RETRY_CUSTOM_TYPE,
            content: RETRY_MESSAGE,
            display: false,
          },
        ],
        continue: true,
      };
    }),
  );

  unsubscribe.push(
    pi.on("agent_settled", async (event) => {
      if (event.aborted || run.submitted) return;
      const attempts = maxRetries > 0 ? ` after ${maxRetries} retr${maxRetries === 1 ? "y" : "ies"}` : "";
      let report = `pi-structured-output: the run ended without a ${SUBMIT_TOOL_NAME} call${attempts}.`;
      if (run.lastAssistantText) report += `\n\nLast assistant text:\n${run.lastAssistantText}`;
      options.writeError(`${report}\n`);
      options.setExitCode(1);
    }),
  );

  return () => {
    while (unsubscribe.length > 0) unsubscribe.pop()!();
  };
}

const defaultIo: StructuredOutputIo = {
  // Pi redirects process.stdout.write to stderr outside the TUI; go straight to the descriptor.
  writeOutput: (text) => {
    writeToStdout(text);
  },
  writeError: (text) => {
    process.stderr.write(text);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exit: (code) => {
    process.exit(code);
  },
};

export default function structuredOutput(
  pi: ExtensionAPI,
  io: Partial<StructuredOutputIo> = {},
): void {
  const effects: StructuredOutputIo = { ...defaultIo, ...io };
  pi.registerFlag(OUTPUT_SCHEMA_FLAG, {
    type: "string",
    default: "",
    description: "JSON Schema (file path or inline JSON) for the final output; print mode emits it as JSON on stdout",
  });

  let deactivate: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const spec = pi.getFlag(OUTPUT_SCHEMA_FLAG);
    if (typeof spec !== "string" || spec.trim() === "") return;

    let schema: OutputSchema;
    try {
      schema = loadOutputSchema(spec, ctx.cwd);
    } catch (error) {
      effects.writeError(`pi-structured-output: ${(error as Error).message}\n`);
      effects.exit(2);
      return;
    }

    deactivate?.();
    deactivate = activateStructuredOutput(pi, { schema, mode: ctx.mode, ...effects });
  });
}
