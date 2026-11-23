'use strict';

const http = require('node:http');
const { validateAndRepairArgs, extractToolCallFromText } = require('./repair.cjs');

/**
 * Creates a local OpenAI-compatible HTTP proxy that validates/repairs tool_calls against request schemas.
 * @param {{ targetUrl: string, port?: number, timeoutMs?: number, maxBodyBytes?: number }} options
 */
function createRepairProxy({ targetUrl, port = 0, timeoutMs = 60000, maxBodyBytes = 10 * 1024 * 1024 }) {
  const stats = {
    requests: 0,
    toolCallsChecked: 0,
    repairedCalls: 0,
    recoveredTextCalls: 0,
    failedCalls: 0
  };
  const normalizedTarget = targetUrl.replace(/\/$/, '');

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/stats')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, targetUrl: normalizedTarget, stats }));
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let abortedTooLarge = false;

    req.on('data', (c) => {
      totalBytes += c.length;
      if (totalBytes > maxBodyBytes) {
        abortedTooLarge = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request payload exceeds maxBodyBytes limit' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', async () => {
      if (abortedTooLarge) return;
      stats.requests += 1;
      const bodyRaw = Buffer.concat(chunks).toString('utf8');
      let requestJson = null;
      try {
        requestJson = bodyRaw ? JSON.parse(bodyRaw) : null;
      } catch {}

      try {
        const forwardHeaders = {
          'content-type': req.headers['content-type'] || 'application/json'
        };
        if (req.headers.authorization) {
          forwardHeaders.authorization = req.headers.authorization;
        }
        if (req.headers.accept) {
          forwardHeaders.accept = req.headers.accept;
        }

        const upstream = await fetch(`${normalizedTarget}${req.url}`, {
          method: req.method,
          headers: forwardHeaders,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyRaw,
          signal: AbortSignal.timeout(timeoutMs)
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

        if (Array.isArray(responseJson?.choices) && toolMap.size > 0) {
          const allowedTools = new Set(toolMap.keys());
          for (let ci = 0; ci < responseJson.choices.length; ci += 1) {
            const choice = responseJson.choices[ci];
            const msg = choice?.message;
            if (!msg) continue;

            if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
              const recovered = extractToolCallFromText(msg.content, allowedTools);
              if (recovered) {
                msg.tool_calls = [
                  {
                    id: `call_repaired_${ci}_0`,
                    type: 'function',
                    function: {
                      name: recovered.name,
                      arguments: typeof recovered.arguments === 'string'
                        ? recovered.arguments
                        : JSON.stringify(recovered.arguments)
                    }
                  }
                ];
                choice.finish_reason = 'tool_calls';
                stats.recoveredTextCalls += 1;
              }
            }

            const calls = msg.tool_calls;
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
        const status = err?.name === 'TimeoutError' ? 504 : 502;
        res.writeHead(status, { 'content-type': 'application/json' });
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
