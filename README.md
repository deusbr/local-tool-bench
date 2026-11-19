# local-tool-bench

[![CI](https://github.com/deusbr/local-tool-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/deusbr/local-tool-bench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](package.json)

Zero-dependency tool-calling benchmark suite and **JSON Schema repair micro-proxy** for local GGUF (`llama.cpp`) and Ollama models.

## Why?

Smaller open-weights local models frequently wrap tool-call JSON in Markdown code fences, emit trailing commas, return stringified integers (`"10"` instead of `10`), or add extra keys even when `additionalProperties: false` is set. `local-tool-bench` measures both **strict** and **repair-assisted** tool-calling accuracy and optionally repairs payloads in flight via a local HTTP proxy.

## Quick Start

```bash
# Run offline repair smoke benchmark
node bin/local-tool-bench.cjs --mock

# Benchmark a local llama.cpp or Ollama OpenAI-compatible server
node bin/local-tool-bench.cjs --endpoint http://127.0.0.1:11434 --model qwen2.5-coder:7b

# Start the local JSON-repair proxy in front of llama.cpp / Ollama
node bin/local-tool-bench.cjs --proxy --endpoint http://127.0.0.1:8080 --port 4318
```

## License

MIT — see [`LICENSE`](LICENSE).