// rpc.test.js — endpoint failover and pinned-block re-pin, against local mocks.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Rpc, auditContract } = require('../src/audit');

function startMock(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { method, params, id } = JSON.parse(body);
      const [status, payload] = handler(method, params);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('Rpc rotates to the next endpoint on HTTP 429', async () => {
  const failing = await startMock(() => [429, {}]);
  const healthy = await startMock((method) => {
    if (method === 'eth_blockNumber') return [200, { result: '0x123' }];
    return [200, { result: '0x' }];
  });
  try {
    const rpc = new Rpc([failing.url, healthy.url]);
    const result = await rpc.call('eth_blockNumber', []);
    assert.equal(result, '0x123');
    assert.equal(rpc.url, healthy.url);
  } finally {
    failing.server.close();
    healthy.server.close();
  }
});

test('Rpc does NOT rotate on an RPC-level error (a revert is an answer)', async () => {
  const node = await startMock(() => [200, {
    error: { code: 3, message: 'execution reverted: Free phase over', data: '0x08c379a0' },
  }]);
  try {
    const rpc = new Rpc([node.url]);
    await assert.rejects(
      rpc.call('eth_call', []),
      (err) => {
        assert.equal(err.isRpcError, true);
        assert.match(err.message, /Free phase over/);
        assert.match(err.message, /revert data: 0x08c379a0/);
        return true;
      }
    );
  } finally {
    node.server.close();
  }
});

test('audit re-pins the block when the RPC says "block not found"', async () => {
  let blockCalls = 0;
  const node = await startMock((method, params) => {
    if (method === 'eth_blockNumber') {
      blockCalls += 1;
      return [200, { result: blockCalls === 1 ? '0x100' : '0x101' }];
    }
    if (method === 'eth_getCode') {
      if (params[1] === '0x100') {
        return [200, { error: { code: -32001, message: 'block not found: 0x100' } }];
      }
      return [200, { result: '0x' }];
    }
    return [200, { result: '0x' }];
  });
  try {
    const report = await auditContract({
      contract: '0x288c7AedbA182246A04430d88470BeF37C40c312',
      rpc: [node.url],
    });
    assert.equal(report.verdict, 'NOT_A_CONTRACT');
    assert.equal(report.repinned, 1);
    assert.equal(report.blockNumber, 0x101);
  } finally {
    node.server.close();
  }
});
