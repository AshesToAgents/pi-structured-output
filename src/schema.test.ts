import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOutputSchema } from "./schema.js";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

function schemaFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-structured-output-"));
  tempDirectories.push(directory);
  const path = join(directory, "schema.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("loadOutputSchema", () => {
  it("reads a JSON schema from a file path relative to cwd", () => {
    const path = schemaFile(JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }));
    const relative = path.slice(tmpdir().length + 1);
    const schema = loadOutputSchema(relative, tmpdir());
    expect(schema).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
  });

  it("parses inline JSON", () => {
    const schema = loadOutputSchema('{"type":"object"}', "/nonexistent");
    expect(schema).toEqual({ type: "object" });
  });

  it("keeps $defs and $ref intact", () => {
    const path = schemaFile(
      JSON.stringify({
        type: "object",
        properties: { items: { type: "array", items: { $ref: "#/$defs/item" } } },
        $defs: { item: { type: "string" } },
      }),
    );
    const schema = loadOutputSchema(path, tmpdir()) as { $defs?: unknown };
    expect(schema.$defs).toEqual({ item: { type: "string" } });
  });

  it("rejects a missing file", () => {
    expect(() => loadOutputSchema(join("does", "not", "exist.json"), tmpdir())).toThrow(
      /does\/not\/exist\.json/,
    );
  });

  it("rejects a file that is not valid JSON", () => {
    const path = schemaFile("{ not json");
    expect(() => loadOutputSchema(path, tmpdir())).toThrow(/not valid JSON/);
  });

  it("rejects a schema whose root is not an object", () => {
    expect(() => loadOutputSchema('{"type":"string"}', tmpdir())).toThrow(/type "object"/);
    expect(() => loadOutputSchema('{"properties":{"a":{"type":"string"}}}', tmpdir())).toThrow(
      /type "object"/,
    );
  });

  it("rejects JSON that is not a schema object at all", () => {
    expect(() => loadOutputSchema("[1,2]", tmpdir())).toThrow(/object/);
    expect(() => loadOutputSchema('"text"', tmpdir())).toThrow(/object/);
  });
});
