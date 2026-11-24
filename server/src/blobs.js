import { del, issueSignedToken, presignUrl, put } from '@vercel/blob';
import express from 'express';

/**
 * Files people upload (employee documents, task attachments) live in the private Blob store. Reading one goes
 * through a link that works for a few minutes, handed out only after the API has checked who is asking.
 */
export async function signedUrl(pathname, { minutes = 10, download = false } = {}) {
  const validUntil = Date.now() + minutes * 60 * 1000;
  const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
  const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil });
  if (!download) return presignedUrl;
  const url = new URL(presignedUrl);
  url.searchParams.set('download', '1');
  return url.toString();
}

export const MAX_FILE_BYTES = 4 * 1024 * 1024; // Vercel caps a request body at 4.5 MB
const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
};

/** The raw request body as the file (the name comes in ?name=); everything else is rejected before it's read. */
export const fileBody = express.raw({ type: () => true, limit: MAX_FILE_BYTES });

/** Checks an upload; returns { error } or { name, ext, contentType, bytes }. */
export function checkUpload(req) {
  const name = String(req.query.name || '').replace(/[\\/\0]/g, '').trim().slice(0, 150);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!name || !TYPES[ext]) return { error: 'Upload a PDF, image, Word, Excel, text or zip file' };
  if (!Buffer.isBuffer(req.body) || !req.body.length) return { error: 'The file is empty' };
  if (req.body.length > MAX_FILE_BYTES) return { error: 'Files can be up to 4 MB' };
  return { name, ext, contentType: TYPES[ext], bytes: req.body.length };
}

export async function storeFile(prefix, file, body) {
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  const blob = await put(`${prefix}/${safe}`, body, { access: 'private', contentType: file.contentType, addRandomSuffix: true });
  return blob.pathname;
}

/** Deletes many files, 500 per call; failures are logged, not thrown (the rows are already gone). */
export async function removeFiles(pathnames) {
  for (let i = 0; i < pathnames.length; i += 500) {
    await del(pathnames.slice(i, i + 500)).catch((err) => console.error('blob delete failed', err.message));
  }
}

export const removeFile = (pathname) => del(pathname).catch((err) => console.error('blob delete failed', pathname, err.message));
