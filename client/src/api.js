const TOKEN_KEY = 'crewline.token';

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
};
export const setToken = (t) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
};

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// Same-origin by default; the Firebase build points at the Vercel API (VITE_API_BASE).
export const API_BASE = import.meta.env.VITE_API_BASE || '/api';

/** URL of the signed-in user's company logo, or null when the company hasn't uploaded one. */
export const companyLogoUrl = (user) =>
  user?.company_logo_v ? `${API_BASE}/companies/${user.company_id}/logo?v=${user.company_logo_v}` : null;

async function request(method, path, body) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    setToken(null);
    window.dispatchEvent(new Event('crewline:logout'));
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

/** Fetches an authenticated file (e.g. a screenshot) and returns an object URL for <img src>. */
async function blobUrl(path) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(`Request failed (${res.status})`, res.status);
  return URL.createObjectURL(await res.blob());
}

/** Sends a file as the raw request body (documents, task attachments); the name goes in the query string. */
async function upload(path, file, params = {}) {
  const token = getToken();
  const qs = new URLSearchParams({ ...params, name: file.name }).toString();
  const res = await fetch(`${API_BASE}${path}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type && file.type !== 'application/json' ? file.type : 'application/octet-stream', ...(token && { Authorization: `Bearer ${token}` }) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || (res.status === 413 ? 'Files can be up to 4 MB' : `Upload failed (${res.status})`), res.status, data);
  return data;
}

/** Opens a file behind a short-lived link; the tab opens first so pop-up blockers allow it. */
async function openFile(path) {
  const tab = window.open('', '_blank');
  try {
    const { url } = await request('GET', path);
    if (tab) tab.location = url;
    else window.location.href = url;
  } catch (err) {
    tab?.close();
    throw err;
  }
}

export const api = {
  blobUrl,
  upload,
  openFile,
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};
