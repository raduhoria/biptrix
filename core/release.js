import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
// What the browser runs or is given: a change here needs a reload.
const DIRS = ['public/js', 'public/css', 'views', 'locales'];

let release = null;

// releaseId: a short hash of the client code, the same on every node of a
// release and unchanged by a plain restart. An open tab compares it with
// the server's (the WebSocket hello) and offers to reload after a deploy.
export function releaseId() {
  if (release) return release;
  const hash = createHash('sha1');
  for (const dir of DIRS) {
    for (const name of readdirSync(path.join(ROOT, dir), { recursive: true }).sort()) {
      const file = path.join(ROOT, dir, name);
      try {
        hash.update(name).update(readFileSync(file));
      } catch {
        // A directory.
      }
    }
  }
  release = hash.digest('hex').slice(0, 12);
  return release;
}
