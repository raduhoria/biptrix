import { readJson } from '../core/router.js';
import { appError } from '../core/util.js';
import { chatView } from '../views/app.js';

// Chat pages and JSON API under /api/o/:org (spec §14). The WebSocket is the
// primary path for sending (core/realtime.js); POST .../messages is the HTTP
// fallback with the same idempotency contract.
export function registerChatRoutes(router, { auth, orgs, chat, files, policies, realtime, events, notifier, config, meetings }) {
  const member = [auth.requireUser, orgs.requireOrg];

  async function page(req, res) {
    const list = await orgs.forUser(req.user.id);
    res.send(chatView({ t: req.t, user: req.user, org: req.org, membership: req.membership, orgs: list, config, isOperator: req.user.platform_role === 'operator' }));
  }
  router.get('/o/:org', ...member, page);
  router.get('/o/:org/c/:id', ...member, page);
  router.get('/o/:org/meetings', ...member, page);

  const api = (path) => `/api/o/:org${path}`;
  const conv = (req) => req.params.id;
  const role = (req) => req.membership.role;

  router.get(api('/bootstrap'), ...member, async (req, res) => {
    const policy = await policies.get(req.org.id);
    res.json({
      cursor: events.cursor(),
      conversations: await chat.list(req.org, req.user),
      directory: await chat.directory(req.org, req.user, role(req)),
      presence: realtime.presenceSnapshot(req.org.id),
      meetings_live: (await meetings.listForUser(req.org, req.user)).filter((m) => m.state === 'live').length,
      policy: { max_file_mb: Math.min(policy.max_file_mb, Math.round(config.maxUploadBytes / 1048576)) },
    });
  });

  router.get(api('/conversations'), ...member, async (req, res) => res.json({ conversations: await chat.list(req.org, req.user) }));

  router.get(api('/conversations/:id'), ...member, async (req, res) => {
    const one = await chat.one(req.org, conv(req), req.user);
    if (!one) throw appError('not_found', 'Conversation not found');
    res.json({ conversation: one });
  });

  router.get(api('/conversations/:id/messages'), ...member, async (req, res) => {
    res.json(await chat.history(req.org, req.user, conv(req), { before: req.query.before, after: req.query.after, parentId: req.query.parent || null, limit: req.query.limit }));
  });

  router.post(api('/conversations/:id/messages'), ...member, async (req, res) => {
    const body = await readJson(req);
    const result = await chat.send(req.org, req.user, {
      conversationId: conv(req),
      clientMessageId: body.client_message_id,
      body: body.body,
      parentId: body.parent_id || null,
      attachmentIds: body.attachment_ids || [],
    });
    if (!result.duplicate) notifier.afterSend(req.org, req.user, await chat.one(req.org, conv(req), req.user), result.message, result.mentioned).catch(() => {});
    res.json({ status: 'persisted', duplicate: result.duplicate, message: result.message });
  });

  router.post(api('/conversations/:id/messages/:mid/edit'), ...member, async (req, res) => {
    const body = await readJson(req);
    await chat.edit(req.org, req.user, { conversationId: conv(req), messageId: req.params.mid, body: body.body, version: body.version });
    res.json({ ok: true });
  });

  router.post(api('/conversations/:id/messages/:mid/delete'), ...member, async (req, res) => {
    await chat.remove(req.org, req.user, role(req), { conversationId: conv(req), messageId: req.params.mid }, req.ip);
    res.json({ ok: true });
  });

  router.post(api('/conversations/:id/messages/:mid/react'), ...member, async (req, res) => {
    await chat.react(req.org, req.user, { conversationId: conv(req), messageId: req.params.mid, emoji: (await readJson(req)).emoji });
    res.json({ ok: true });
  });

  router.post(api('/conversations/:id/messages/:mid/pin'), ...member, async (req, res) => {
    await chat.pin(req.org, req.user, role(req), { conversationId: conv(req), messageId: req.params.mid, pinned: !!(await readJson(req)).pinned }, req.ip);
    res.json({ ok: true });
  });

  router.get(api('/conversations/:id/pinned'), ...member, async (req, res) => res.json({ messages: await chat.pinned(req.org, req.user, conv(req)) }));
  router.get(api('/conversations/:id/members'), ...member, async (req, res) => res.json({ members: await chat.members(req.org, req.user, conv(req)) }));

  router.post(api('/conversations/:id/members'), ...member, async (req, res) => {
    await chat.addMembers(req.org, req.user, role(req), conv(req), (await readJson(req)).user_ids || [], req.ip);
    res.json({ ok: true });
  });

  router.post(api('/conversations/:id/members/:uid/remove'), ...member, async (req, res) => {
    await chat.removeMember(req.org, req.user, role(req), conv(req), req.params.uid, req.ip);
    res.json({ ok: true });
  });

  router.post(api('/conversations/:id/members/:uid/role'), ...member, async (req, res) => {
    await chat.setMemberRole(req.org, req.user, role(req), conv(req), req.params.uid, (await readJson(req)).role, req.ip);
    res.json({ ok: true });
  });

  router.post(api('/conversations/:id/update'), ...member, async (req, res) => {
    await chat.update(req.org, req.user, role(req), conv(req), await readJson(req), req.ip);
    res.json({ ok: true });
  });

  router.post(api('/conversations/:id/read'), ...member, async (req, res) => {
    await chat.markRead(req.org, req.user, conv(req), (await readJson(req)).seq);
    res.json({ ok: true });
  });

  router.post(api('/conversations/:id/mute'), ...member, async (req, res) => {
    await chat.setMuted(req.org, req.user, conv(req), !!(await readJson(req)).muted);
    res.json({ ok: true });
  });

  router.post(api('/dms'), ...member, async (req, res) => {
    res.json({ conversation: await chat.openDm(req.org, req.user, role(req), String((await readJson(req)).user_id || '')) });
  });

  router.post(api('/groups'), ...member, async (req, res) => {
    const body = await readJson(req);
    res.json({ conversation: await chat.createGroup(req.org, req.user, role(req), { memberIds: body.user_ids || [], name: body.name }) });
  });

  router.post(api('/spaces'), ...member, async (req, res) => {
    const body = await readJson(req);
    res.json({ conversation: await chat.createSpace(req.org, req.user, role(req), { name: body.name, description: body.description, visibility: body.visibility, memberIds: body.user_ids || [] }, req.ip) });
  });

  router.get(api('/spaces'), ...member, async (req, res) => res.json({ spaces: await chat.browseSpaces(req.org, req.user) }));

  router.post(api('/spaces/:id/join'), ...member, async (req, res) => {
    res.json({ conversation: await chat.joinSpace(req.org, req.user, role(req), req.params.id) });
  });

  router.post(api('/files'), ...member, async (req, res) => res.json({ file: await files.upload(req.org, req.user, req) }));

  router.get(api('/files/:id'), ...member, async (req, res) => {
    await files.send(req.org, req.user, req.params.id, res, { download: req.query.download === '1' });
  });

  router.get(api('/search'), ...member, async (req, res) => {
    res.json(await chat.search(req.org, req.user, { q: req.query.q, conversationId: req.query.conversation || '', authorId: req.query.author || '', from: req.query.from || '', to: req.query.to || '' }));
  });
}
