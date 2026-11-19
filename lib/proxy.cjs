'use strict';

const http = require('node:http');
const { validateAndRepairArgs } = require('./repair.cjs');

/**
 * Creates a local OpenAI-compatible HTTP proxy that validates/repairs tool_calls against request schemas.
 * @param {{ targetUrl: string, port?: number }} options
 */
function createRepairProxy({ targetUrl, port = 0 }) {
  const stats = { requests: 0, toolCallsChecked: 0, repairedCalls: 0, failedCalls: 0 };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      stats.requests += 1;
      const bodyRaw = Buffer.concat(chunks).toString('utf8');
      let requestJson = null;
      try {
        requestJson = bodyRaw ? JSON.parse(bodyRaw) : null;
      } catch {}

      try {
        const upstream = await fetch(`${targetUrl.replace(/\/$/, '')}${req.url}`, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] || 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyRaw
        });
        const upstreamText = await upstream.text();
        let responseJson;
        try {
          responseJson = JSON.parse(upstreamText);
        } catch {
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/plain' });
          res.end(upstreamText);
          return;
        }

        const toolMap = new Map();
        if (Array.isArray(requestJson?.tools)) {
          for (const t of requestJson.tools) {
            if (t?.function?.name) toolMap.set(t.function.name, t.function.parameters || {});
          }
        }

        if (Array.isArray(responseJson?.choices)) {
          for (const choice of responseJson.choices) {
            const calls = choice?.message?.tool_calls;
            if (!Array.isArray(calls)) continue;
            for (const call of calls) {
              const schema = toolMap.get(call?.function?.name);
              if (!schema) continue;
              stats.toolCallsChecked += 1;
              const check = validateAndRepairArgs(call.function.arguments, schema);
              if (check.ok && check.value) {
                call.function.arguments = JSON.stringify(check.value);
                if (check.repaired) stats.repairedCalls += 1;
              } else {
                stats.failedCalls += 1;
              }
            }
          }
        }

        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responseJson));
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  return {
    server,
    stats,
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address()))),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { createRepairProxy };