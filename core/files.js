import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { appError, newId, nowIso } from './util.js';

// MIME allowlist by extension; the stored type comes from this table, never
// from the client. Inline display only for types that cannot run script.
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', log: 'text/plain', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  zip: 'application/zip', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'audio/mpeg']);
// Magic numbers for the types a browser would render inline.
const MAGIC = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

export const ALLOWED_EXTENSIONS = Object.keys(TYPES);

function cleanName(name) {
  const base = path.basename(String(name || 'file').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
  return (base || 'file').slice(0, 180);
}

// createFiles: attachments are written under FILES_DIR/<org>/<opaque id>
// (outside the webroot, no extension, never executed), registered in the
// attachments table and linked to a message by chat.send. Downloads check
// conversation membership on every request (spec §7.3, §15).
export function createFiles({ db, config, policies }) {
  const root = path.resolve(config.filesDir);

  function avScan(file) {
    if (!config.avScanCmd) return Promise.resolve();
    const [cmd, ...args] = config.avScanCmd.split(/\s+/);
    return new Promise((resolve, reject) => {
      execFile(cmd, [...args, file], { timeout: 120_000 }, (err) => (err ? reject(appError('invalid', 'File rejected by antivirus', { reason: 'virus' })) : resolve()));
    });
  }

  async function storageUsed(orgId) {
    return (await db.get('SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE org_id = ?', [orgId])).bytes;
  }

  async function upload(org, user, req) {
    const name = cleanName(decodeURIComponent(String(req.headers['x-file-name'] || 'file')));
    const ext = path.extname(name).slice(1).toLowerCase();
    const mime = TYPES[ext];
    if (!mime) throw appError('invalid', 'File type not allowed', { reason: 'type' });
    const policy = await policies.get(org.id);
    const limit = Math.min(config.maxUploadBytes, policy.max_file_mb * 1024 * 1024);
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) throw appError('invalid', 'File too large', { reason: 'size', max: Math.round(limit / 1048576) });
    if ((await storageUsed(org.id)) + declared > org.storage_quota_mb * 1048576) throw appError('quota_exceeded', 'Storage quota reached', { reason: 'storage' });

    const id = newId();
    const key = `${org.id}/${id}`;
    const target = path.join(root, key);
    const temp = `${target}.part`;
    await mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk, enc, cb) {
        size += chunk.length;
        if (size > limit) return cb(appError('invalid', 'File too large', { reason: 'size', max: Math.round(limit / 1048576) }));
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16)]);
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, createWriteStream(temp, { flags: 'wx', mode: 0o640 }));
      if (!size) throw appError('invalid', 'Empty file');
      const magic = MAGIC[mime];
      if (magic && !magic.every((b, i) => head[i] === b)) throw appError('invalid', 'File content does not match its type', { reason: 'type' });
      await avScan(temp);
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    await db.batch([
      ['INSERT INTO attachments (id, org_id, uploader_id, name, mime, size, sha256, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, org.id, user.id, name, mime, size, hash.digest('hex'), key, nowIso()]],
      [
        'INSERT INTO usage_counters (org_id, period, metric, value) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, period, metric) DO UPDATE SET value = value + excluded.value',
        [org.id, nowIso().slice(0, 7), 'upload_bytes', size],
      ],
    ]);
    return { id, name, mime, size };
  }

  // Download: the file's message must be in a conversation the user belongs
  // to (or, before sending, the uploader is the user) and not deleted.
  async function send(org, user, fileId, res, { download = false } = {}) {
    const file = await db.get(
      `SELECT a.* FROM attachments a LEFT JOIN messages m ON m.id = a.message_id
       WHERE a.id = ? AND a.org_id = ? AND (
         (a.message_id IS NULL AND a.uploader_id = ?)
         OR (m.deleted_at IS NULL AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = a.conversation_id AND cm.user_id = ?)))`,
      [fileId, org.id, user.id, user.id]
    );
    if (!file) throw appError('not_found', 'File not found');
    const full = path.resolve(root, file.storage_key);
    if (!full.startsWith(root + path.sep)) throw appError('forbidden', 'Bad storage key');
    await stat(full);
    const inline = !download && INLINE.has(file.mime);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    await pipeline(createReadStream(full), res);
  }

  // Uploads never attached to a message are removed after a day.
  async function pruneOrphans() {
    const cutoff = new Date(Date.now() - 86400_000).toISOString();
    const rows = await db.all('SELECT id, storage_key FROM attachments WHERE message_id IS NULL AND created_at < ? LIMIT 500', [cutoff]);
    for (const row of rows) {
      await unlink(path.join(root, row.storage_key)).catch(() => {});
      await db.run('DELETE FROM attachments WHERE id = ?', [row.id]);
    }
  }

  return { upload, send, storageUsed, pruneOrphans };
}
