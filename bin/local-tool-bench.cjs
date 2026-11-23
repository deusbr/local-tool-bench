#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { runBenchmark, DEFAULT_CASES } = require('../lib/bench.cjs');
const { createRepairProxy } = require('../lib/proxy.cjs');

function parseArgs(argv) {
  const args = {
    mode: 'mock',
    endpoint: null,
    model: 'local-gguf',
    port: 4318,
    timeoutMs: 30000,
    apiKey: process.env.OPENAI_API_KEY || null,
    casesFile: null,
    help: false
  };
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
    else if (a === '--timeout' && argv[i + 1]) args.timeoutMs = Number(argv[++i]) || 30000;
    else if (a === '--api-key' && argv[i + 1]) args.apiKey = argv[++i];
    else if (a === '--cases' && argv[i + 1]) args.casesFile = argv[++i];
  }
  return args;
}

function mockRunner(tc) {
  const samples = {
    'fs-read-range': '```json\n{"path":"src/server.js","startLine":"10","endLine":"40",}\n```',
    'mcp-install-scope': '{"clientId":"Claude-Code","serverName":"lume","command":"node","args":"[\\"server.cjs\\"]"}',
    'deploy-preview-flags': '<think>Checking {port} config</think>\n<tool_call>{"service":"api-gw","dryRun":"true","env":"{\\"PORT\\":\\"3000\\",\\"extra\\":1}"}</tool_call>',
    'sql-query-limit': '{"dialect":"POSTGRES","query":"SELECT id, name FROM users","limit":"25","explain":"false"}',
    'git-worktree-create': '{"branch":"feat/repair-proxy","path":".worktrees/repair","createBranch":true}'
  };
  return {
    function: {
      name: tc.expectedTool,
      arguments: samples[tc.id] || '{}'
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: local-tool-bench [--mock | --endpoint <url> --model <name> | --proxy --endpoint <url> --port 4318] [--timeout <ms>] [--cases <path>] [--api-key <token>]'
    );
    process.exit(0);
  }

  if (args.mode === 'proxy') {
    if (!args.endpoint) throw new Error('--endpoint is required in --proxy mode.');
    const proxy = createRepairProxy({
      targetUrl: args.endpoint,
      port: args.port,
      timeoutMs: args.timeoutMs
    });
    const addr = await proxy.listen();
    console.log(`local-tool-bench repair proxy listening on http://127.0.0.1:${addr.port} -> ${args.endpoint}`);
    return;
  }

  const cases = args.casesFile
    ? JSON.parse(fs.readFileSync(args.casesFile, 'utf8'))
    : DEFAULT_CASES;

  const report = await runBenchmark({
    endpoint: args.endpoint,
    model: args.model,
    cases,
    timeoutMs: args.timeoutMs,
    apiKey: args.apiKey,
    runner: args.mode === 'mock' ? async (tc) => mockRunner(tc) : null
  });

  console.log(JSON.stringify(report, null, 2));
  if (report.passed < report.total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
