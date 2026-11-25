# pi-structured-output

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that makes `pi -p` end with a JSON document conforming to a schema you define, so pi can be used as a tool in pipelines.

```bash
pi -p --output-schema examples/review.schema.json "Review the staged changes" | jq '.findings[] | select(.severity == "blocker")'
```

## Install

```bash
pi install ssh://git@github.com/AshesToAgents/pi-structured-output.git
```

## What's Included

| Component | Description |
|-----------|-------------|
| `--output-schema <path\|json>` | CLI flag taking a JSON Schema file path or inline JSON |
| `submit_output` tool | Registered when the flag is set; the model ends the run by calling it |

## Usage

The schema is a JSON Schema whose root has `type: "object"`. `$ref`/`$defs` are supported.

**Agentic work first, structured answer last.** The model keeps its tools (`read`, `bash`, ...) and ends by calling `submit_output`:

```bash
pi -p --output-schema review.schema.json "Review src/payments for retry bugs"
```

**Pure transformation.** To keep other tools away from the model, name only the output tool:

```bash
git log --oneline -20 | pi -p --tools submit_output --output-schema summary.schema.json "Categorize these commits"
```

**Inline schema:**

```bash
pi -p --output-schema '{"type":"object","required":["sentiment"],"properties":{"sentiment":{"type":"string","enum":["positive","negative","neutral"]}}}' "Classify: $TEXT"
```

See [examples/review.schema.json](examples/review.schema.json) for a complete code-review schema.

### Output contract

| Stream | Content |
|--------|---------|
| stdout | One compact JSON document per prompt, one per line (JSONL for multiple prompts) |
| stderr | Diagnostics only |
| Exit code | `0` on success, `1` when no conforming output was produced, `2` for an unusable schema or tool selection |

## How It Works

1. At session start the extension loads the schema and registers `submit_output` with the schema as the tool's parameters and prompt guidelines telling the model to end with it.
2. Pi validates every call against the schema before the tool runs; an invalid call becomes an error result the model sees and corrects on its next turn.
3. A valid call is written to stdout and terminates the run (`terminate: true`), so no extra model turn is spent on a prose answer.
4. If a run ends without a call, the extension injects a reminder and continues, up to 2 retries. If there is still nothing, it reports the failure on stderr, includes the model's last text, and sets exit code 1.
5. Assistant prose is stripped from the transcript in print mode so it can never leak into stdout; thinking and tool calls are kept.

## Limitations

- `--no-tools` and `--tools` allowlists that omit `submit_output` remove the tool before it can be activated. The extension exits with code 2 and a hint; use `--tools submit_output` for a run without other tools.
- Schema enforcement is Pi's local validation, which coerces loosely typed values (numeric strings to numbers, `"true"` to `true`). Provider-side constrained decoding is not used.
- Field semantics (what an enum value means, how a score is derived) must be conveyed through `description`s; the schema only enforces structure.
- In interactive, JSON and RPC modes the tool is registered but nothing is written to stdout.
- The `--output-schema` flag has no effect unless it is set; pi behaves normally otherwise.

## Development

```bash
npm install
npm run typecheck
npm test
```

Try it against the local checkout without installing:

```bash
pi -p -e ./src/index.ts --output-schema examples/review.schema.json "Review src/schema.ts"
```

## License

MIT
