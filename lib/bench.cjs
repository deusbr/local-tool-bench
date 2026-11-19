'use strict';

const { validateAndRepairArgs } = require('./repair.cjs');

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
              args: { type: 'array' }
            }
          }
        }
      }
    ],
    expectedTool: 'install_mcp_client'
  }
];

async function invokeModel(endpoint, model, testCase) {
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  return data.choices?.[0]?.message?.tool_calls?.[0] || null;
}

async function runBenchmark({ endpoint = null, model = 'local-gguf', cases = DEFAULT_CASES, runner = null } = {}) {
  const results = [];
  for (const tc of cases) {
    const startedAt = Date.now();
    let call = null;
    let invokeError = null;
    try {
      if (runner) {
        call = await runner(tc);
      } else if (endpoint) {
        call = await invokeModel(endpoint, model, tc);
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
        repaired: false,
        latencyMs: Date.now() - startedAt,
        error: invokeError || 'No tool call emitted'
      });
      continue;
    }

    const toolMatch = call.function?.name === tc.expectedTool;
    const checked = validateAndRepairArgs(call.function?.arguments, expectedDef);
    results.push({
      id: tc.id,
      passed: toolMatch && checked.ok,
      strictPassed: toolMatch && checked.ok && !checked.repaired,
      repaired: checked.repaired,
      repairs: checked.repairs,
      errors: toolMatch ? checked.errors : [`Expected tool ${tc.expectedTool}, got ${call.function?.name}`],
      latencyMs: Date.now() - startedAt
    });
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const strictPassed = results.filter((r) => r.strictPassed).length;
  return {
    model,
    total,
    passed,
    strictPassed,
    passRate: total ? Number((passed / total).toFixed(2)) : 0,
    results
  };
}

module.exports = {
  DEFAULT_CASES,
  runBenchmark
};