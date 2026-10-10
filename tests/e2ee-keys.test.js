import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createE2ee } from '../public/js/e2ee.js';

// Key exchange of call encryption (public/js/e2ee.js) over a relay that
// can drop messages, like a WebSocket that goes down: keys must still
// reach everyone, and the status must not claim more than is true.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (await fn()) return true;
  return false;
}

function network() {
  const nodes = new Map();
  const down = new Set(); // ids whose socket is down (nothing in or out)
  function add(id) {
    const worker = { sent: null, recv: new Map(), postMessage(m) {
      if (m.type === 'send-key') this.sent = { tag: Array.from(m.tag, (b) => b.toString(16).padStart(2, '0')).join(''), index: m.index };
      if (m.type === 'recv-key') this.recv.set(`${m.tag}:${m.index}`, true);
    } };
    const node = createE2ee({
      worker,
      onChange() {},
      signal(to, data) {
        if (down.has(id) || down.has(to)) return false;
        setTimeout(() => nodes.get(to)?.e2ee.onSignal(id, data.e2ee), 5);
        return true;
      },
    });
    node.start(id);
    nodes.set(id, { e2ee: node, worker });
    return nodes.get(id);
  }
  // Does `to` hold the key `from` sends with now?
  const holds = (from, to) => {
    const s = nodes.get(from).worker.sent;
    return !!s && nodes.get(to).worker.recv.has(`${s.tag}:${s.index}`);
  };
  return { add, down, holds };
}

describe('call key exchange', () => {
  test('two participants: each holds the key the other sends with', async () => {
    const net = network();
    const a = net.add('a');
    const b = net.add('b');
    a.e2ee.setPeers(['b']);
    b.e2ee.setPeers(['a']);
    assert.ok(await until(() => net.holds('a', 'b') && net.holds('b', 'a') && a.e2ee.status() === 'ok' && b.e2ee.status() === 'ok'));
  });

  test('a socket down during a key change: no false "ok", and the key arrives after the reconnect', async () => {
    const net = network();
    const a = net.add('a');
    const b = net.add('b');
    a.e2ee.setPeers(['b']);
    b.e2ee.setPeers(['a']);
    assert.ok(await until(() => a.e2ee.status() === 'ok' && b.e2ee.status() === 'ok'));
    net.down.add('a');
    // Someone joins and leaves while A is cut off: A makes a new key that
    // B never receives; after the maximum wait A uses it anyway.
    a.e2ee.setPeers(['b', 'c']);
    a.e2ee.setPeers(['b']);
    await wait(5600);
    assert.equal(net.holds('a', 'b'), false, 'B lacks the new key');
    assert.equal(a.e2ee.status(), 'pending', 'A does not claim B can decrypt');
    // Back online (same participants): resync.
    net.down.delete('a');
    a.e2ee.resync();
    assert.ok(await until(() => net.holds('a', 'b') && net.holds('b', 'a') && a.e2ee.status() === 'ok' && b.e2ee.status() === 'ok'));
  });

  test('a lost key message is sent again without any reconnect', async () => {
    const net = network();
    const a = net.add('a');
    const b = net.add('b');
    net.down.add('b'); // B's first messages are lost
    a.e2ee.setPeers(['b']);
    b.e2ee.setPeers(['a']);
    await wait(300);
    net.down.delete('b');
    assert.ok(await until(() => net.holds('a', 'b') && net.holds('b', 'a') && a.e2ee.status() === 'ok' && b.e2ee.status() === 'ok', 8000));
  });
});
