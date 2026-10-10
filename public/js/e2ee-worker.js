import { decryptFrame, encryptFrame, importFrameKey } from './e2ee-frame.js';

// Call media encryption, off the main thread. Every sender and receiver of
// the call gets an RTCRtpScriptTransform on this worker ({ side, kind });
// the page (e2ee.js) hands over the keys:
//   { type: 'send-key', tag, index, raw }  our own key: frames we send use it
//   { type: 'recv-key', tag, index, raw }  a participant's key
//   { type: 'forget', tag }                a participant who left
// Nothing is sent before our key is set, and frames nobody can decrypt are
// dropped: no media ever leaves or is shown unencrypted.

let send = null; // { tag: Uint8Array, index, key }
const recv = new Map(); // tagHex → Map<index, CryptoKey> (the last few)
const KEEP = 4;

self.onmessage = async ({ data: m }) => {
  if (m.type === 'send-key') {
    send = { tag: new Uint8Array(m.tag), index: m.index, key: await importFrameKey(m.raw) };
  } else if (m.type === 'recv-key') {
    const keys = recv.get(m.tag) || new Map();
    keys.set(m.index, await importFrameKey(m.raw));
    while (keys.size > KEEP) keys.delete(keys.keys().next().value);
    recv.set(m.tag, keys);
  } else if (m.type === 'forget') {
    recv.delete(m.tag);
  }
};

const lookup = (tag, index) => recv.get(tag)?.get(index);

self.onrtctransform = ({ transformer }) => {
  const { side, kind } = transformer.options;
  const transform =
    side === 'send'
      ? async (frame, controller) => {
          if (!frame.data.byteLength) return controller.enqueue(frame);
          if (!send) return;
          frame.data = (await encryptFrame(send.key, send.index, send.tag, kind, frame.type, new Uint8Array(frame.data))).buffer;
          controller.enqueue(frame);
        }
      : async (frame, controller) => {
          if (!frame.data.byteLength) return controller.enqueue(frame);
          const plain = await decryptFrame(lookup, kind, frame.type, new Uint8Array(frame.data));
          if (!plain) return;
          frame.data = plain.buffer;
          controller.enqueue(frame);
        };
  transformer.readable.pipeThrough(new TransformStream({ transform })).pipeTo(transformer.writable);
};
