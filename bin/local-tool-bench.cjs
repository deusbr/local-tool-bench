#!/usr/bin/env node
'use strict';

const { runBenchmark } = require('../lib/bench.cjs');
const { createRepairProxy } = require('../lib/proxy.cjs');

function parseArgs(argv) {
  const args = { mode: 'mock', endpoint: null, model: 'local-gguf', port: 4318, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--proxy') args.mode = 'proxy';
    else if (a === '--mock') args.mode = 'mock';
    else if (a === '--endpoint' && argv[i + 1]) {
      args.endpoint = argv[++i];
      if (args.mode === 'mock') args.mode = 'bench';
    } else if (a === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (a === '--port' && argv[i + 1]) args.port = Number(argv[++i]) || 4318;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: local-tool-bench [--mock | --endpoint <url> --model <name> | --proxy --endpoint <url> --port 4318]');
    process.exit(0);
  }

  if (args.mode === 'proxy') {
    if (!args.endpoint) throw new Error('--endpoint is required in --proxy mode.');
    const proxy = createRepairProxy({ targetUrl: args.endpoint, port: args.port });
    const addr = await proxy.listen();
    console.log(`local-tool-bench repair proxy listening on http://127.0.0.1:${addr.port} -> ${args.endpoint}`);
    return;
  }

  const report = await runBenchmark({
    endpoint: args.endpoint,
    model: args.model,
    runner:
      args.mode === 'mock'
        ? async (tc) => ({
            function: {
              name: tc.expectedTool,
              arguments:
                tc.id === 'fs-read-range'
                  ? '```json\n{"path":"src/server.js","startLine":"10","endLine":"40",}\n```'
                  : '{"clientId":"claude-code","serverName":"lume","command":"node","args":["server.cjs"]}'
            }
          })
        : null
  });

  console.log(JSON.stringify(report, null, 2));
  if (report.passed < report.total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});