// Shared helpers for the SwarmBase dashboard pages.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(v) { return '$' + (Number(v) || 0).toFixed(2); }
function money3(v) { return '$' + (Number(v) || 0).toFixed(3); }
function dur(ms) {
  if (!(ms >= 0)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}
function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return iso.slice(0, 10);
}
function chip(status) { return `<span class="chip s-${esc(status)}">${esc(status)}</span>`; }
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
async function postJSON(url) {
  const r = await fetch(url, { method: 'POST', headers: { 'X-SwarmBase': '1' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.status);
  return body;
}
let WHO = { login: null, admin: false };
async function showWho() {
  try {
    WHO = await getJSON('/api/whoami');
    const el = document.getElementById('who');
    if (el) el.textContent = WHO.login ? `${WHO.login}${WHO.admin ? ' · admin' : ''}` : 'no tailnet identity (read-only)';
  } catch { /* ignore */ }
  return WHO;
}
