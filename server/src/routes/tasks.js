import { Router } from 'express';
import db from '../db.js';
import { isManager } from '../auth.js';
import { emit } from '../events.js';
import { clock, isRealDate } from '../utils.js';
import { checkUpload, fileBody, removeFile, removeFiles, signedUrl, storeFile } from '../blobs.js';

/**
 * Tasks. Admin and HR create, edit, reassign and delete any task; a senior employee can do the same for the people
 * who report to them (users.reports_to). Everyone sees their own tasks and moves them between To do, In progress
 * and Done. Time comes from the desktop tracker (task_time, see routes/tracker.js).
 */
const router = Router();
// Task ids in the URL: anything that isn't a whole number simply isn't a task.
const taskIdOf = (req) => (/^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0);
const PRIORITIES = ['low', 'medium', 'high'];
const STATUSES = ['todo', 'progress', 'done'];

export const TASK_SQL = `
  SELECT t.*, u.name AS assignee, u.emp_code, c.name AS created_by_name,
         COALESCE((SELECT SUM(seconds) FROM task_time tt WHERE tt.task_id = t.id), 0)::int AS logged_seconds,
         (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id)::int AS comment_count
  FROM tasks t JOIN users u ON u.id = t.assignee_id LEFT JOIN users c ON c.id = t.created_by`;

/** Validates and normalises the editable fields; returns { error } or the clean values. */
function fields(body, partial) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title) return { error: 'Give the task a title' };
    if (title.length > 200) return { error: 'Keep the title under 200 characters' };
    out.title = title;
  }
  if (body.details !== undefined) out.details = String(body.details || '').trim().slice(0, 2000) || null;
  if (!partial || body.assignee_id !== undefined) {
    out.assignee_id = Number(body.assignee_id);
    if (!out.assignee_id) return { error: 'Choose who the task is for' };
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) return { error: 'Priority must be low, medium or high' };
    out.priority = body.priority;
  }
  if (body.due_date !== undefined) {
    if (body.due_date && !isRealDate(body.due_date)) return { error: 'Invalid due date' };
    out.due_date = body.due_date || null;
  }
  if (body.estimate_minutes !== undefined) {
    const m = body.estimate_minutes === '' || body.estimate_minutes == null ? null : Math.round(Number(body.estimate_minutes));
    if (m != null && (!Number.isFinite(m) || m < 0 || m > 100000)) return { error: 'Invalid estimate' };
    out.estimate_minutes = m;
  }
  return out;
}

/** People the caller may give tasks to: everyone active for admin/HR, otherwise their direct juniors. */
function assignable(user) {
  return isManager(user)
    ? db.all(`SELECT id, name, designation, reports_to FROM users WHERE company_id = ? AND status = 'active' ORDER BY name`, [user.company_id])
    : db.all(`SELECT id, name, designation, reports_to FROM users WHERE company_id = ? AND status = 'active' AND reports_to = ? ORDER BY name`, [user.company_id, user.id]);
}

/** The assignee, if the caller may give them tasks. */
function canAssignTo(user, id) {
  return isManager(user)
    ? db.get(`SELECT id, name FROM users WHERE id = ? AND company_id = ? AND status = 'active'`, [id, user.company_id])
    : db.get(`SELECT id, name FROM users WHERE id = ? AND company_id = ? AND status = 'active' AND reports_to = ?`, [id, user.company_id, user.id]);
}

/** Admin/HR manage every task; a senior manages the tasks of people who report to them. */
async function canManage(user, task) {
  if (isManager(user)) return true;
  return Boolean(await db.get('SELECT 1 FROM users WHERE id = ? AND reports_to = ?', [task.assignee_id, user.id]));
}

router.get('/people', async (req, res) => res.json(await assignable(req.user)));

router.get('/', async (req, res) => {
  const params = [req.user.company_id];
  let sql = `${TASK_SQL} WHERE t.company_id = ?`;
  if (req.query.mine) {
    sql += ' AND t.assignee_id = ?';
    params.push(req.user.id);
  } else if (!isManager(req.user)) {
    // A senior's team view: their juniors' tasks. Anyone else only ever sees their own.
    sql += ' AND (t.assignee_id = ? OR t.assignee_id IN (SELECT id FROM users WHERE reports_to = ?))';
    params.push(req.user.id, req.user.id);
    if (req.query.team) {
      sql += ' AND t.assignee_id <> ?';
      params.push(req.user.id);
    }
  } else if (req.query.assignee_id) {
    sql += ' AND t.assignee_id = ?';
    params.push(Number(req.query.assignee_id));
  }
  // Done tasks drop off after 30 days so the list stays about current work.
  sql += ` AND (t.status <> 'done' OR t.completed_at >= localtimestamp - interval '30 days')`;
  res.json(await db.all(`${sql} ORDER BY t.status = 'done', t.due_date NULLS LAST, t.id DESC`, params));
});

router.post('/', async (req, res) => {
  const f = fields(req.body || {}, false);
  if (f.error) return res.status(400).json(f);
  const who = await canAssignTo(req.user, f.assignee_id);
  if (!who) {
    return isManager(req.user)
      ? res.status(400).json({ error: 'That person is not an active employee here' })
      : res.status(403).json({ error: 'You can only give tasks to people who report to you' });
  }
  const now = clock(req.user.timezone);
  const task = await db.get(
    `INSERT INTO tasks (company_id, title, details, assignee_id, created_by, priority, due_date, estimate_minutes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [req.user.company_id, f.title, f.details ?? null, f.assignee_id, req.user.id, f.priority || 'medium', f.due_date ?? null, f.estimate_minutes ?? null, now.dateTime]
  );
  if (who.id !== req.user.id) {
    await emit(req.user, {
      type: 'task.assigned', audience: 'user', userId: who.id, notify: true,
      title: `New task from ${req.user.name}: ${f.title}`, data: { taskId: task.id },
    });
  }
  await emit(req.user, { type: 'task.changed', data: { taskId: task.id } });
  res.status(201).json(await db.get(`${TASK_SQL} WHERE t.id = ?`, [task.id]));
});

router.patch('/:id', async (req, res) => {
  const task = await db.get('SELECT * FROM tasks WHERE id = ? AND company_id = ?', [taskIdOf(req), req.user.company_id]);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const manager = await canManage(req.user, task);
  if (!manager && task.assignee_id !== req.user.id) return res.status(404).json({ error: 'Task not found' });

  const body = req.body || {};
  const set = {};
  if (manager) {
    const f = fields(body, true);
    if (f.error) return res.status(400).json(f);
    if (f.assignee_id && !(await canAssignTo(req.user, f.assignee_id))) {
      return res.status(400).json({ error: 'You can only give tasks to people who report to you' });
    }
    Object.assign(set, f);
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
    set.status = body.status;
    set.completed_at = body.status === 'done' ? clock(req.user.timezone).dateTime : null;
  }
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to change' });

  const cols = Object.keys(set);
  await db.run(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => set[c]), task.id]);
  if (set.status === 'done' && task.status !== 'done') {
    const title = `${req.user.name} finished: ${task.title}`;
    await emit(req.user, { type: 'task.done', notify: true, title, data: { taskId: task.id } });
    // A senior who gave the task (and isn't admin/HR, who already got it above) hears about it too.
    const creator = task.created_by && task.created_by !== req.user.id
      && await db.get(`SELECT id FROM users WHERE id = ? AND role = 'employee'`, [task.created_by]);
    if (creator) await emit(req.user, { type: 'task.done', audience: 'user', userId: creator.id, notify: true, title, data: { taskId: task.id } });
  }
  if (set.assignee_id && set.assignee_id !== task.assignee_id && set.assignee_id !== req.user.id) {
    await emit(req.user, {
      type: 'task.assigned', audience: 'user', userId: set.assignee_id, notify: true,
      title: `New task from ${req.user.name}: ${set.title || task.title}`, data: { taskId: task.id },
    });
  }
  await emit(req.user, { type: 'task.changed', audience: 'all', data: { taskId: task.id } });
  res.json(await db.get(`${TASK_SQL} WHERE t.id = ?`, [task.id]));
});

router.delete('/:id', async (req, res) => {
  const task = await db.get('SELECT * FROM tasks WHERE id = ? AND company_id = ?', [taskIdOf(req), req.user.company_id]);
  if (!task || !(await canManage(req.user, task))) return res.status(404).json({ error: 'Task not found' });
  const files = await db.all('SELECT blob_path FROM task_comments WHERE task_id = ? AND blob_path IS NOT NULL', [task.id]);
  const gone = await db.get('DELETE FROM tasks WHERE id = ? RETURNING id', [task.id]);
  if (!gone) return res.status(404).json({ error: 'Task not found' });
  await removeFiles(files.map((f) => f.blob_path));
  await emit(req.user, { type: 'task.changed', audience: 'all', data: { taskId: gone.id } });
  res.json({ ok: true });
});

/* ---------- Discussion: comments and files on a task ---------- */
/** The task, if the caller may see it: admin/HR, the assignee, or the assignee's senior. */
async function visibleTask(req) {
  const task = await db.get('SELECT * FROM tasks WHERE id = ? AND company_id = ?', [taskIdOf(req), req.user.company_id]);
  if (!task) return null;
  return task.assignee_id === req.user.id || (await canManage(req.user, task)) ? task : null;
}

const COMMENT_SQL = `SELECT c.id, c.task_id, c.user_id, u.name AS author, c.body, c.file_name, c.content_type, c.bytes, c.created_at
  FROM task_comments c LEFT JOIN users u ON u.id = c.user_id`;

/** Tells the others on the task (assignee, whoever gave it) about a new comment or file. */
async function notifyComment(req, task, text) {
  const others = new Set([task.assignee_id, task.created_by].filter((id) => id && id !== req.user.id));
  for (const id of others) {
    await emit(req.user, {
      type: 'task.comment', audience: 'user', userId: id, notify: true,
      title: `${req.user.name} on "${task.title}"`, body: text.slice(0, 200), data: { taskId: task.id },
    });
  }
  await emit(req.user, { type: 'task.changed', audience: 'all', data: { taskId: task.id } });
}

router.get('/:id/comments', async (req, res) => {
  const task = await visibleTask(req);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(await db.all(`${COMMENT_SQL} WHERE c.task_id = ? ORDER BY c.id`, [task.id]));
});

router.post('/:id/comments', async (req, res) => {
  const task = await visibleTask(req);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write something first' });
  const row = await db.get(
    `INSERT INTO task_comments (task_id, company_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [task.id, req.user.company_id, req.user.id, body.slice(0, 2000), clock(req.user.timezone).dateTime]
  );
  await notifyComment(req, task, body);
  res.status(201).json(await db.get(`${COMMENT_SQL} WHERE c.id = ?`, [row.id]));
});

router.post('/:id/files', fileBody, async (req, res) => {
  const task = await visibleTask(req);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const file = checkUpload(req);
  if (file.error) return res.status(400).json(file);
  const blobPath = await storeFile(`tasks/c${req.user.company_id}/t${task.id}`, file, req.body);
  const row = await db.get(
    `INSERT INTO task_comments (task_id, company_id, user_id, file_name, blob_path, content_type, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [task.id, req.user.company_id, req.user.id, file.name, blobPath, file.contentType, file.bytes, clock(req.user.timezone).dateTime]
  );
  await notifyComment(req, task, `Attached ${file.name}`);
  res.status(201).json(await db.get(`${COMMENT_SQL} WHERE c.id = ?`, [row.id]));
});

async function commentOf(req, task) {
  const id = /^\d{1,9}$/.test(req.params.cid) ? Number(req.params.cid) : 0;
  return db.get('SELECT * FROM task_comments WHERE id = ? AND task_id = ?', [id, task.id]);
}

router.get('/:id/comments/:cid/url', async (req, res) => {
  const task = await visibleTask(req);
  const c = task && await commentOf(req, task);
  if (!c?.blob_path) return res.status(404).json({ error: 'File not found' });
  res.json({ url: await signedUrl(c.blob_path, { download: Boolean(req.query.download) }), name: c.file_name });
});

/** The author removes their own comment; admin/HR or the senior can remove any on the task. */
router.delete('/:id/comments/:cid', async (req, res) => {
  const task = await visibleTask(req);
  const c = task && await commentOf(req, task);
  if (!c || (c.user_id !== req.user.id && !(await canManage(req.user, task)))) return res.status(404).json({ error: 'Comment not found' });
  await db.run('DELETE FROM task_comments WHERE id = ?', [c.id]);
  if (c.blob_path) await removeFile(c.blob_path);
  await emit(req.user, { type: 'task.changed', audience: 'all', data: { taskId: task.id } });
  res.json({ ok: true });
});

export default router;
