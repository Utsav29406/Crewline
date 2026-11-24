import { Router } from 'express';
import db from '../db.js';
import { isManager } from '../auth.js';
import { emit } from '../events.js';
import { clock } from '../utils.js';
import { checkUpload, fileBody, removeFile, signedUrl, storeFile } from '../blobs.js';

/**
 * Employee documents (ID proof, offer letter, contracts...). Admin/HR see and manage everyone's; an employee sees
 * their own and can add to them (e.g. upload their ID), but only admin/HR delete.
 */
const router = Router();
export const CATEGORIES = ['id_proof', 'offer_letter', 'contract', 'payslip', 'certificate', 'other'];
const idOf = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : 0);
const canSee = (req, userId) => isManager(req.user) || req.user.id === userId;

async function person(req) {
  const id = idOf(req.params.id);
  if (!canSee(req, id)) return null;
  return db.get('SELECT id, name FROM users WHERE id = ? AND company_id = ?', [id, req.user.company_id]);
}

router.get('/employees/:id/documents', async (req, res) => {
  const p = await person(req);
  if (!p) return res.status(404).json({ error: 'Employee not found' });
  res.json(await db.all(
    `SELECT d.id, d.category, d.name, d.content_type, d.bytes, d.created_at, u.name AS uploaded_by_name
     FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.user_id = ? ORDER BY d.id DESC`,
    [p.id]
  ));
});

router.post('/employees/:id/documents', fileBody, async (req, res) => {
  const p = await person(req);
  if (!p) return res.status(404).json({ error: 'Employee not found' });
  const file = checkUpload(req);
  if (file.error) return res.status(400).json(file);
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : 'other';
  const blobPath = await storeFile(`docs/c${req.user.company_id}/u${p.id}`, file, req.body);
  const row = await db.get(
    `INSERT INTO documents (company_id, user_id, category, name, blob_path, content_type, bytes, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, category, name, content_type, bytes, created_at`,
    [req.user.company_id, p.id, category, file.name, blobPath, file.contentType, file.bytes, req.user.id, clock(req.user.timezone).dateTime]
  );
  // Someone adding their own document lets HR know; HR adding one lets the person know.
  if (p.id === req.user.id) {
    await emit(req.user, { type: 'document.added', notify: true, title: `${req.user.name} uploaded ${file.name}`, data: { userId: p.id } });
  } else {
    await emit(req.user, {
      type: 'document.added', audience: 'user', userId: p.id, notify: true,
      title: `${req.user.name} added a document to your profile: ${file.name}`, data: { userId: p.id },
    });
    await emit(req.user, { type: 'document.added', data: { userId: p.id } });
  }
  res.status(201).json(row);
});

async function documentFor(req) {
  const d = await db.get('SELECT * FROM documents WHERE id = ? AND company_id = ?', [idOf(req.params.id), req.user.company_id]);
  return d && canSee(req, d.user_id) ? d : null;
}

/** A link to open (or with ?download=1, save) the file, valid for 10 minutes. */
router.get('/documents/:id/url', async (req, res) => {
  const d = await documentFor(req);
  if (!d) return res.status(404).json({ error: 'Document not found' });
  res.json({ url: await signedUrl(d.blob_path, { download: Boolean(req.query.download) }), name: d.name });
});

router.delete('/documents/:id', async (req, res) => {
  const d = await documentFor(req);
  if (!d || !isManager(req.user)) return res.status(404).json({ error: 'Document not found' });
  await db.run('DELETE FROM documents WHERE id = ?', [d.id]);
  await removeFile(d.blob_path);
  await emit(req.user, { type: 'document.removed', audience: 'all', data: { userId: d.user_id } });
  res.json({ ok: true });
});

export default router;
