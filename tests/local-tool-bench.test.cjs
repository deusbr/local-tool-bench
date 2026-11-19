'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { validateAndRepairArgs, runBenchmark, createRepairProxy } = require('../index.cjs');

test('validateAndRepairArgs unwraps markdown JSON, removes trailing commas, coerces types, and strips unknown keys', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'startLine'],
    properties: {
      path: { type: 'string' },
      startLine: { type: 'integer' }
    }
  };

  const noisy = 'Sure! Here is the call:\n```json\n{\n  "path": "app.js",\n  "startLine": "12",\n  "hallucinated": true,\n}\n```';
  const res = validateAndRepairArgs(noisy, schema);

  assert.equal(res.ok, true);
  assert.equal(res.repaired, true);
  assert.deepEqual(res.value, { path: 'app.js', startLine: 12 });
  assert.ok(res.repairs.includes('coerced:startLine->integer'));
  assert.ok(res.repairs.includes('stripped_unknown:hallucinated'));
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

test('runBenchmark evaluates strict vs repaired passes', async () => {
  const report = await runBenchmark({
    model: 'qwen-local-test',
    runner: async (tc) => ({
      function: {
        name: tc.expectedTool,
        arguments:
          tc.id === 'fs-read-range'
            ? '{"path":"a.js","startLine":"1","endLine":"20"}'
            : '{"clientId":"claude-code","serverName":"lume","command":"node"}'
      }
    })
  });

  assert.equal(report.total, 2);
  assert.equal(report.passed, 2);
  assert.equal(report.strictPassed, 1);
  assert.equal(report.passRate, 1);
});

test('createRepairProxy repairs upstream GGUF tool_calls in flight', async () => {
  const mockUpstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
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
  });

  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upPort = mockUpstream.address().port;
  const proxy = createRepairProxy({ targetUrl: `http://127.0.0.1:${upPort}` });
  const proxyAddr = await proxy.listen();

  try {
    const resp = await fetch(`http://127.0.0.1:${proxyAddr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
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
      })
    });
    const data = await resp.json();
    const repairedArgs = JSON.parse(data.choices[0].message.tool_calls[0].function.arguments);
    assert.deepEqual(repairedArgs, { path: 'index.js', startLine: 5, endLine: 25 });
    assert.equal(proxy.stats.repairedCalls, 1);
  } finally {
    await proxy.close();
    await new Promise((resolve) => mockUpstream.close(resolve));
  }
});