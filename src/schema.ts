import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** A JSON Schema object whose root has `type: "object"`, usable as a tool's parameter schema. */
export type OutputSchema = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the flag value is the schema itself rather than a path to one. */
function looksInline(spec: string): boolean {
  return /^[{["]/.test(spec);
}

/**
 * Load the output schema named by `--output-schema`: inline JSON, or a JSON file path resolved
 * relative to `cwd`. Throws with a user-facing message when it cannot be used.
 */
export function loadOutputSchema(spec: string, cwd: string): OutputSchema {
  const trimmed = spec.trim();
  let text: string;
  let source: string;

  if (looksInline(trimmed)) {
    text = trimmed;
    source = "inline schema";
  } else {
    const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
    source = path;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`--output-schema: cannot read ${path}: ${(error as Error).message}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--output-schema: ${source} is not valid JSON: ${(error as Error).message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`--output-schema: ${source} must be a JSON object`);
  }
  if (parsed.type !== "object") {
    throw new Error(`--output-schema: ${source} must have type "object" at its root`);
  }
  return parsed;
}
