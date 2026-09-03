import { Router } from 'express';
import { ApiError } from '../errors.js';
import { requireAuth, requireRoles, sessionUser } from '../http/guards.js';
import { canViewMember } from '../http/guards.js';
import {
  archiveMember,
  createMember,
  findMemberById,
  listMembers,
  parseMemberPayload,
  toMemberDto,
  updateMember,
} from '../services/members.js';

export const membersRouter = Router();

membersRouter.use(requireAuth);

membersRouter.get('/', requireRoles('owner', 'membership_officer'), async (req, res) => {
  const result = await listMembers(
    {
      search: typeof req.query.search === 'string' ? req.query.search : '',
      status: typeof req.query.status === 'string' ? req.query.status : '',
      group: typeof req.query.group === 'string' ? req.query.group : '',
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.pageSize ?? 20),
    },
    sessionUser(req),
  );
  res.json(result);
});

membersRouter.get('/:id', async (req, res) => {
  const user = sessionUser(req);
  const row = await findMemberById(String(req.params.id));
  if (!row) throw ApiError.notFound('Member not found.', 'MEMBER_NOT_FOUND');
  if (!canViewMember(user, row)) throw ApiError.forbidden('You are not permitted to view this member.');
  res.json({ member: toMemberDto(row, user) });
});

membersRouter.post('/', requireRoles('owner', 'membership_officer'), async (req, res) => {
  const member = await createMember(parseMemberPayload(req.body, { requireConsent: true }), sessionUser(req));
  res.status(201).json({
    member,
    message: 'Member saved. Birthday reminders are active; the next eligible alert will follow the parish rule.',
  });
});

membersRouter.patch('/:id', requireRoles('owner', 'membership_officer'), async (req, res) => {
  const member = await updateMember(
    String(req.params.id),
    parseMemberPayload({ ...(req.body as object), consentRecorded: true }),
    sessionUser(req),
  );
  res.json({ member, message: 'Member updated. The next eligible birthday alert will use these details.' });
});

membersRouter.post('/:id/archive', requireRoles('owner', 'membership_officer'), async (req, res) => {
  await archiveMember(String(req.params.id), sessionUser(req));
  res.json({ message: 'Member archived. Future birthday alerts are suppressed.' });
});
