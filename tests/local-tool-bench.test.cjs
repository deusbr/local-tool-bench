'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  validateAndRepairArgs,
  extractJsonCandidate,
  extractToolCallFromText,
  runBenchmark,
  createRepairProxy
} = require('../index.cjs');

test('validateAndRepairArgs unwraps markdown JSON, removes trailing commas safely, coerces types, and strips unknown keys', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'startLine', 'note'],
    properties: {
      path: { type: 'string' },
      startLine: { type: 'integer' },
      note: { type: 'string' }
    }
  };

  const noisy =
    'Sure! Here is the call:\n```json\n{\n  "path": "app.js",\n  "startLine": "12.0",\n  "note": "keep, [literal] and , } intact",\n  "hallucinated": true,\n}\n```';
  const res = validateAndRepairArgs(noisy, schema);

  assert.equal(res.ok, true);
  assert.equal(res.repaired, true);
  assert.deepEqual(res.value, {
    path: 'app.js',
    startLine: 12,
    note: 'keep, [literal] and , } intact'
  });
  assert.ok(res.repairs.includes('coerced:startLine->integer'));
  assert.ok(res.repairs.includes('stripped_unknown:hallucinated'));
});

test('extractJsonCandidate ignores <think> blocks with braces and extracts <tool_call> payloads', () => {
  const raw = '<think>Consider {invalid: brace} or {"draft": 1}</think>\n<tool_call>\n{"path":"src/index.js","startLine":1,}\n</tool_call>';
  const res = extractJsonCandidate(raw);
  assert.equal(res.extracted, true);
  assert.deepEqual(res.value, { path: 'src/index.js', startLine: 1 });
});

test('validateAndRepairArgs repairs nested objects, stringified arrays, union types, and enum casing', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['clientId', 'args', 'env'],
    properties: {
      clientId: { type: 'string', enum: ['claude-code', 'cursor'] },
      args: { type: 'array', items: { type: 'integer' } },
      retries: { type: ['integer', 'null'] },
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
  };

  const raw = JSON.stringify({
    clientId: 'Claude-Code',
    args: '["1", "2", 3]',
    retries: '4',
    env: '{"PORT":"3000","DEBUG":"true","UNUSED":"drop"}',
    extraTop: 99
  });

  const res = validateAndRepairArgs(raw, schema);
  assert.equal(res.ok, true);
  assert.equal(res.repaired, true);
  assert.deepEqual(res.value, {
    clientId: 'claude-code',
    args: [1, 2, 3],
    retries: 4,
    env: { PORT: 3000, DEBUG: true }
  });
  assert.ok(res.repairs.includes('normalized_enum:clientId'));
  assert.ok(res.repairs.includes('coerced:args->array'));
  assert.ok(res.repairs.includes('coerced:env->object'));
  assert.ok(res.repairs.includes('stripped_unknown:env.UNUSED'));
});

test('validateAndRepairArgs rejects invalid enum values and missing required fields', () => {
  const schema = {
    type: 'object',
    required: ['clientId'],
    properties: { clientId: { type: 'string', enum: ['claude-code', 'cursor'] } }
  };

  const badEnum = validateAndRepairArgs('{"clientId":"unknown"}', schema);
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.errors[0], /not in enum/);

  const missing = validateAndRepairArgs('{}', schema);
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /Missing required/);
});

test('extractToolCallFromText recovers allowed tool call from <tool_call> text', () => {
  const text = '<think>Need to read file</think><tool_call>{"name":"read_file_range","arguments":{"path":"a.js","startLine":"1","endLine":5}}</tool_call>';
  const call = extractToolCallFromText(text, ['read_file_range']);
  assert.deepEqual(call, {
    name: 'read_file_range',
    arguments: { path: 'a.js', startLine: '1', endLine: 5 },
    source: 'xml_tool_call'
  });
  assert.equal(extractToolCallFromText(text, ['other_tool']), null);
});

test('runBenchmark evaluates strict vs repaired passes across default suite', async () => {
  const report = await runBenchmark({
    model: 'qwen-local-test',
    runner: async (tc) => {
      if (tc.id === 'fs-read-range') {
        return { function: { name: tc.expectedTool, arguments: '{"path":"a.js","startLine":"1","endLine":"20"}' } };
      }
      if (tc.id === 'mcp-install-scope') {
        return { function: { name: tc.expectedTool, arguments: '{"clientId":"claude-code","serverName":"lume","command":"node"}' } };
      }
      if (tc.id === 'deploy-preview-flags') {
        return { function: { name: tc.expectedTool, arguments: '{"service":"api","dryRun":true,"env":{"PORT":3000}}' } };
      }
      if (tc.id === 'sql-query-limit') {
        return { function: { name: tc.expectedTool, arguments: '{"dialect":"postgres","query":"SELECT 1","limit":10}' } };
      }
      return { function: { name: tc.expectedTool, arguments: '{"branch":"main","path":".wt"}' } };
    }
  });

  assert.equal(report.total, 5);
  assert.equal(report.passed, 5);
  assert.equal(report.strictPassed, 4);
  assert.equal(report.repairedCount, 1);
  assert.equal(report.strictPassRate, 0.8);
  assert.equal(report.passRate, 1);
});

test('createRepairProxy repairs upstream GGUF tool_calls, recovers text tool calls, forwards auth, and serves /stats', async () => {
  let seenAuth = null;
  let reqCount = 0;

  const mockUpstream = http.createServer((req, res) => {
    seenAuth = req.headers.authorization || null;
    reqCount += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (reqCount === 1) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'read_file_range',
                      arguments: '```json\n{"path":"index.js","startLine":"5","endLine":"25",}\n```'
                    }
                  }
                ]
              }
            }
          ]
        })
      );
      return;
    }

    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '<think>Calling tool</think><tool_call>{"name":"read_file_range","arguments":{"path":"lib.js","startLine":"1","endLine":"10"}}</tool_call>'
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upPort = mockUpstream.address().port;
  const proxy = createRepairProxy({ targetUrl: `http://127.0.0.1:${upPort}` });
  const proxyAddr = await proxy.listen();

  const requestBody = JSON.stringify({
    model: 'local',
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file_range',
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
    ]
  });

  try {
    const resp1 = await fetch(`http://127.0.0.1:${proxyAddr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: requestBody
    });
    const data1 = await resp1.json();
    assert.equal(seenAuth, 'Bearer test-token');
    assert.deepEqual(JSON.parse(data1.choices[0].message.tool_calls[0].function.arguments), {
      path: 'index.js',
      startLine: 5,
      endLine: 25
    });

    const resp2 = await fetch(`http://127.0.0.1:${proxyAddr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody
    });
    const data2 = await resp2.json();
    assert.equal(data2.choices[0].finish_reason, 'tool_calls');
    assert.equal(data2.choices[0].message.tool_calls[0].function.name, 'read_file_range');
    assert.deepEqual(JSON.parse(data2.choices[0].message.tool_calls[0].function.arguments), {
      path: 'lib.js',
      startLine: 1,
      endLine: 10
    });

    const statsResp = await fetch(`http://127.0.0.1:${proxyAddr.port}/stats`);
    const statsData = await statsResp.json();
    assert.equal(statsData.ok, true);
    assert.equal(statsData.stats.requests, 2);
    assert.equal(statsData.stats.toolCallsChecked, 2);
    assert.equal(statsData.stats.repairedCalls, 2);
    assert.equal(statsData.stats.recoveredTextCalls, 1);
  } finally {
    await proxy.close();
    await new Promise((resolve) => mockUpstream.close(resolve));
  }
});
