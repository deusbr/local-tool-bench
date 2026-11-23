# local-tool-bench

[![CI](https://github.com/deusbr/local-tool-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/deusbr/local-tool-bench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](package.json)

Zero-dependency tool-calling benchmark suite and **JSON Schema repair micro-proxy** for local GGUF (`llama.cpp`) and Ollama models.

## Why?

Smaller open-weights local models frequently:
- Emit reasoning blocks (`<think>...</think>`) or `<tool_call>...</tool_call>` XML tags inside assistant text instead of structured `tool_calls`.
- Wrap tool-call JSON in Markdown code fences or add trailing commas.
- Return stringified primitives, arrays, or nested objects (`"10"`, `"true"`, `"[\"server.cjs\"]"`).
- Drift on enum casing (`"Claude-Code"` vs `"claude-code"`) or add extra keys even when `additionalProperties: false` is set.

`local-tool-bench` measures both **strict** (`strictPassRate`) and **repair-assisted** (`passRate`) tool-calling accuracy across 5 built-in scenarios (or custom `--cases` JSON files) and repairs payloads in flight via a local OpenAI-compatible HTTP proxy.

## Features (`v1.1.0`)

- **String-Safe JSON Repair (`lib/repair.cjs`):** Strips `<think>...</think>` blocks, unwraps `<tool_call>` / `<function_call>` tags and Markdown fences, removes trailing commas strictly outside string literals, and scans balanced JSON objects.
- **Recursive Schema Coercion:** Validates and repairs nested `object` properties, `array` items, union `type` arrays (e.g. `["integer", "null"]`), stringified JSON arrays/objects, integer-formatted floats (`"10.0"`), and case-insensitive `enum` normalization.
- **Text-to-Tool-Call Recovery (`lib/proxy.cjs`):** Automatically converts `<tool_call>` or JSON tool calls emitted inside `message.content` into structured OpenAI `message.tool_calls` when `tool_calls` is absent.
- **Proxy Observability & Safety:** Exposes `GET /health` and `GET /stats`, forwards `Authorization` headers, enforces request timeouts (`--timeout`), and bounds payload size (`maxBodyBytes`).

## Quick Start

```bash
# Run offline repair smoke benchmark (5 built-in scenarios)
node bin/local-tool-bench.cjs --mock

# Benchmark a local llama.cpp or Ollama OpenAI-compatible server
node bin/local-tool-bench.cjs --endpoint http://127.0.0.1:11434 --model qwen2.5-coder:7b

# Benchmark with a custom JSON test suite and timeout
node bin/local-tool-bench.cjs --endpoint http://127.0.0.1:8080 --model local-gguf --cases ./my-cases.json --timeout 45000

# Start the local JSON-repair proxy in front of llama.cpp / Ollama
node bin/local-tool-bench.cjs --proxy --endpoint http://127.0.0.1:8080 --port 4318
```

Check live proxy counters anytime:

```bash
curl http://127.0.0.1:4318/stats
```

## License

MIT — see [`LICENSE`](LICENSE).
