'use strict';

const { validateAndRepairArgs, extractToolCallFromText } = require('./repair.cjs');

const DEFAULT_CASES = [
  {
    id: 'fs-read-range',
    prompt: 'Read lines 10 to 40 of src/server.js.',
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file_range',
          description: 'Read a line range from a file.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'startLine', 'endLine'],
            properties: {
              path: { type: 'string' },
              startLine: { type: 'integer' },
              endLine: { type: 'integer' }
            }
          }
        }
      }
    ],
    expectedTool: 'read_file_range'
  },
  {
    id: 'mcp-install-scope',
    prompt: 'Install server "lume" for client "claude-code" with node server.cjs.',
    tools: [
      {
        type: 'function',
        function: {
          name: 'install_mcp_client',
          description: 'Register an MCP server into a desktop/CLI client.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['clientId', 'serverName', 'command'],
            properties: {
              clientId: { type: 'string', enum: ['claude-desktop', 'claude-code', 'cursor', 'codex'] },
              serverName: { type: 'string' },
              command: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      }
    ],
    expectedTool: 'install_mcp_client'
  },
  {
    id: 'deploy-preview-flags',
    prompt: 'Deploy service "api-gw" to staging with dryRun=true and env PORT=3000.',
    tools: [
      {
        type: 'function',
        function: {
          name: 'deploy_preview',
          description: 'Deploy a preview service with environment variables.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['service', 'dryRun', 'env'],
            properties: {
              service: { type: 'string' },
              dryRun: { type: 'boolean' },
              env: {
                type: 'object',
                additionalProperties: false,
                required: ['PORT'],
                properties: {
                  PORT: { type: 'integer' },
                  DEBUG: { type: 'boolean' }
                }
              }
            }
          }
        }
      }
    ],
    expectedTool: 'deploy_preview'
  },
  {
    id: 'sql-query-limit',
    prompt: 'Run read-only postgres query on table users with limit 25.',
    tools: [
      {
        type: 'function',
        function: {
          name: 'run_sql_query',
          description: 'Execute a bounded SQL query.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['dialect', 'query', 'limit'],
            properties: {
              dialect: { type: 'string', enum: ['postgres', 'sqlite', 'mysql'] },
              query: { type: 'string' },
              limit: { type: 'integer' },
              explain: { type: 'boolean' }
            }
          }
        }
      }
    ],
    expectedTool: 'run_sql_query'
  },
  {
    id: 'git-worktree-create',
    prompt: 'Create a git worktree for branch feat/repair-proxy under .worktrees/repair.',
    tools: [
      {
        type: 'function',
        function: {
          name: 'create_worktree',
          description: 'Create an isolated git worktree checkout.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['branch', 'path'],
            properties: {
              branch: { type: 'string' },
              path: { type: 'string' },
              createBranch: { type: 'boolean' }
            }
          }
        }
      }
    ],
    expectedTool: 'create_worktree'
  }
];

async function invokeModel(endpoint, model, testCase, { timeoutMs = 30000, apiKey = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${endpoint.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: 'user', content: testCase.prompt }],
      tools: testCase.tools
    })
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${endpoint}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (msg?.tool_calls?.[0]) {
    return { call: msg.tool_calls[0], recoveredFromText: false };
  }
  const allowedTools = (testCase.tools || []).map((t) => t?.function?.name).filter(Boolean);
  const textCall = extractToolCallFromText(msg?.content, allowedTools);
  if (textCall) {
    return {
      call: { function: { name: textCall.name, arguments: textCall.arguments } },
      recoveredFromText: true
    };
  }
  return { call: null, recoveredFromText: false };
}

async function runBenchmark({
  endpoint = null,
  model = 'local-gguf',
  cases = DEFAULT_CASES,
  runner = null,
  timeoutMs = 30000,
  apiKey = null
} = {}) {
  const results = [];
  for (const tc of cases) {
    const startedAt = Date.now();
    let call = null;
    let recoveredFromText = false;
    let invokeError = null;
    try {
      if (runner) {
        const out = await runner(tc);
        if (out && typeof out === 'object' && 'call' in out) {
          call = out.call;
          recoveredFromText = Boolean(out.recoveredFromText);
        } else {
          call = out;
        }
      } else if (endpoint) {
        const invoked = await invokeModel(endpoint, model, tc, { timeoutMs, apiKey });
        call = invoked.call;
        recoveredFromText = invoked.recoveredFromText;
      } else {
        throw new Error('Provide either endpoint or custom runner');
      }
    } catch (err) {
      invokeError = err.message;
    }

    const expectedDef = tc.tools.find((t) => t.function.name === tc.expectedTool)?.function.parameters;
    if (invokeError || !call) {
      results.push({
        id: tc.id,
        passed: false,
        strictPassed: false,
        repaired: false,
        recoveredFromText: false,
        latencyMs: Date.now() - startedAt,
        error: invokeError || 'No tool call emitted'
      });
      continue;
    }

    const toolMatch = call.function?.name === tc.expectedTool;
    const checked = validateAndRepairArgs(call.function?.arguments, expectedDef);
    const repaired = checked.repaired || recoveredFromText;
    results.push({
      id: tc.id,
      passed: toolMatch && checked.ok,
      strictPassed: toolMatch && checked.ok && !repaired,
      repaired,
      recoveredFromText,
      repairs: recoveredFromText ? ['recovered_from_text', ...checked.repairs] : checked.repairs,
      errors: toolMatch ? checked.errors : [`Expected tool ${tc.expectedTool}, got ${call.function?.name}`],
      latencyMs: Date.now() - startedAt
    });
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const strictPassed = results.filter((r) => r.strictPassed).length;
  const repairedCount = results.filter((r) => r.passed && r.repaired).length;
  return {
    model,
    total,
    passed,
    strictPassed,
    repairedCount,
    strictPassRate: total ? Number((strictPassed / total).toFixed(2)) : 0,
    passRate: total ? Number((passed / total).toFixed(2)) : 0,
    results
  };
}

module.exports = {
  DEFAULT_CASES,
  runBenchmark
};
