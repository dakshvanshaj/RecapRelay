// Business rules for the meeting-recap -> CRM relay.
// Pure functions; the same text is inlined into the n8n Code nodes by build.js.
// All times are IST wall-clock, held as "fake UTC" Dates (read with getUTC*), so host timezone never matters.

const DAY = 86400000;
const IST_MS = 330 * 60000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ist = (d) => new Date(d.getTime() + IST_MS);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (f) => `${f.getUTCFullYear()}-${pad(f.getUTCMonth() + 1)}-${pad(f.getUTCDate())} ${pad(f.getUTCHours())}:${pad(f.getUTCMinutes())}`;
const nice = (f) => `${DOW[f.getUTCDay()]} ${f.getUTCDate()} ${MON[f.getUTCMonth()]}`;
// 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM[...]' -> fake-UTC Date, or null
function parseWall(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0))) : null;
}

// Blank everywhere means '', 'NaN', 'N/A' or missing.
function clean(v) {
  const s = v == null ? '' : String(v).trim();
  return ['', 'nan', 'n/a'].includes(s.toLowerCase()) ? '' : s;
}

// The ONLY place that knows the transcript-extraction step's output shape. Swap this if the
// actual prompt/model returns different field names — everything below works off this normalized shape.
function fromExtraction(body) {
  const b = body || {};
  const actionItems = Array.isArray(b.action_items) ? b.action_items
    .map((it) => ({ text: clean(it && (it.text || it.item)), owner: clean(it && it.owner) }))
    .filter((it) => it.text) : [];
  return {
    meetingId: clean(b.meeting_id || b.id),
    account: clean(b.account || b.company || b.deal),
    contact: clean(b.contact || b.contact_name),
    rep: clean(b.rep || b.sales_rep),
    team: clean(b.team || b.pipeline),
    summary: clean(b.summary),
    actionItems,
    nextStep: clean(b.next_step || b.next_meeting),
    risks: Array.isArray(b.risks) ? b.risks.map(clean).filter(Boolean) : [],
    sourceUrl: clean(b.source_url || b.recording_url),
  };
}

function ownerFor(team, settings) {
  const s = settings || [];
  const reachable = (r) => clean(r.WhatsApp) || clean(r.Email);
  const c = s.find((r) => r.Role === 'Team Owner' && String(r.Team).trim().toLowerCase() === String(team || '').trim().toLowerCase() && reachable(r))
    || s.find((r) => r.Role === 'Fallback Owner' && reachable(r));
  return c ? { Name: c.Name, WhatsApp: clean(c.WhatsApp), Email: clean(c.Email) } : null;
}

const REQUIRED = [['account', 'account/deal name'], ['summary', 'meeting summary']];

// existing = the Meetings row already holding this meeting, or null. An update keeps the first
// logged time; everything else is replaced with the latest extraction. There's no approval state
// on this row to protect — the per-item Done status lives on the Action Items rows instead, and
// THAT is protected (see actionItemRows).
function buildRecap(doc, receivedAt, settings, existing) {
  const flags = [];
  const missing = REQUIRED.filter(([k]) => !doc[k]).map(([, label]) => label);
  if (missing.length) flags.push('Missing: ' + missing.join(', '));
  if (!doc.actionItems.length) flags.push('No action items captured');
  if (doc.risks.length) flags.push(`Risk flagged: ${doc.risks.join(', ')}`);
  const c = ownerFor(doc.team, settings);
  if (!c) flags.push(`No owner set for team ${doc.team || '?'}`);
  const row = {
    'Logged at': (existing && existing['Logged at']) || fmt(ist(receivedAt)),
    'Meeting ID': doc.meetingId || `no-id-${receivedAt.getTime()}`,
    Account: doc.account, Contact: doc.contact, Team: doc.team, Summary: doc.summary,
    'Action items': doc.actionItems.length, 'Next step': doc.nextStep,
    Owner: (c && c.Name) || doc.rep || doc.team, Flags: flags.join('; '),
  };
  const subject = `${row.Flags ? '⚠ ' : ''}Meeting recap: ${doc.account || '?'}${doc.contact ? ` – ${doc.contact}` : ''}`;
  return { row, to: (c && c.WhatsApp) || null, email: c ? c.Email : '', subject, updated: !!existing };
}

// One row per action item in a separate sheet, matched on a stable per-item ID so a human's Done
// mark is never lost: re-processing the same meeting (a corrected transcript, a re-run) only
// refreshes the text/owner of an item, never its Status.
function actionItemRows(doc, receivedAt, existingItems) {
  const existing = existingItems || [];
  const loggedAt = fmt(ist(receivedAt));
  return doc.actionItems.map((it, i) => {
    const itemId = `${doc.meetingId || 'no-id'}-${i + 1}`;
    const prev = existing.find((r) => r['Item ID'] === itemId);
    return {
      'Item ID': itemId, 'Meeting ID': doc.meetingId || '', Account: doc.account,
      Item: it.text, Owner: it.owner || doc.contact || '',
      'Logged at': (prev && prev['Logged at']) || loggedAt,
      Status: (prev && prev.Status) || 'Open',
    };
  });
}

// Weekly digest: every action item still Open across every meeting, oldest first.
function openDigest(itemRows, now) {
  const n = ist(now);
  const open = (itemRows || []).filter((r) => r.Status !== 'Done');
  const days = (r) => Math.floor((n - parseWall(r['Logged at'])) / DAY);
  const stale = open.filter((r) => days(r) >= 7);
  const oldest = open.filter((r) => parseWall(r['Logged at']))
    .sort((a, b) => parseWall(a['Logged at']) - parseWall(b['Logged at'])).slice(0, 5)
    .map((r) => ({ ...r, days: days(r) }));
  return { n, open, stale, oldest };
}

function weeklyDigestText(itemRows, now, sheetUrl) {
  const v = openDigest(itemRows, now);
  return [
    `Open action items – ${nice(v.n)}`,
    `Open: ${v.open.length}`,
    `Stale (7+ days): ${v.stale.length}`,
    ...(v.oldest.length ? ['Waiting longest:', ...v.oldest.map((r) => `- ${r.Item} (${r.Account}), ${r.days} days`)] : []),
    `Full list: ${sheetUrl}`,
  ].join('\n');
}

// ---- HTML email (inline styles only: email clients drop <style> blocks) ----
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const FONT = "font-family:Arial,Helvetica,sans-serif;color:#1f2937;";
function shell(title, colour, body, sheetUrl, footer) {
  return `<div style="${FONT}max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">`
    + `<div style="background:${colour};color:#fff;padding:14px 18px;font-size:18px;font-weight:bold">${title}</div>`
    + `<div style="padding:16px 18px">${body}`
    + `<p style="margin:18px 0 4px"><a href="${esc(sheetUrl)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:9px 14px;border-radius:6px;font-size:14px;display:inline-block">Open Meetings sheet</a></p>`
    + `</div><div style="padding:10px 18px;background:#f9fafb;color:#6b7280;font-size:12px">${footer}</div></div>`;
}
const tr = (k, v, strong) => `<tr><td style="padding:6px 10px 6px 0;color:#6b7280;font-size:14px;white-space:nowrap;vertical-align:top">${k}</td>`
  + `<td style="padding:6px 0;font-size:14px;${strong ? 'font-weight:bold;' : ''}">${v || '<span style="color:#b91c1c">not set</span>'}</td></tr>`;

function recapHtml(resp, doc, sheetUrl) {
  const r = resp.row;
  const banner = r.Flags
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;color:#92400e;padding:10px 12px;margin-bottom:14px;font-size:14px">⚠ ${esc(r.Flags)}</div>` : '';
  const items = doc.actionItems.length
    ? `<p style="margin:16px 0 6px;font-weight:bold;font-size:14px">Action items</p><ul style="margin:0;padding-left:18px;font-size:14px">`
      + `${doc.actionItems.map((it) => `<li style="margin:3px 0">${esc(it.text)}${it.owner ? ` <span style="color:#6b7280">(${esc(it.owner)})</span>` : ''}</li>`).join('')}</ul>` : '';
  const body = banner + `<table style="border-collapse:collapse;width:100%">`
    + tr('Account', esc(r.Account), true) + tr('Contact', esc(r.Contact)) + tr('Summary', esc(r.Summary))
    + tr('Next step', esc(r['Next step'])) + tr('Owner', esc(r.Owner))
    + (doc.sourceUrl ? `<tr><td colspan="2" style="padding:10px 0 0"><a href="${esc(doc.sourceUrl)}" style="font-size:13px">View the recording/transcript →</a></td></tr>` : '')
    + `</table>` + items;
  const title = `${resp.updated ? 'Updated: ' : ''}Meeting recap${r.Account ? ` – ${esc(r.Account)}` : ''}`;
  return shell(title, r.Flags ? '#b45309' : '#0f766e', body, sheetUrl, "Logged automatically after every call. Mark an action item Done in the Action Items sheet once it's handled.");
}

function weeklyDigestHtml(itemRows, now, sheetUrl) {
  const v = openDigest(itemRows, now);
  const tile = (label, num, colour) => `<td style="padding:4px;width:50%"><div style="border:1px solid #e5e7eb;border-radius:6px;padding:10px;text-align:center">`
    + `<div style="font-size:24px;font-weight:bold;color:${colour}">${num}</div><div style="font-size:12px;color:#6b7280">${label}</div></div></td>`;
  const list = (heading, items, line) => items.length
    ? `<p style="margin:16px 0 6px;font-weight:bold;font-size:14px">${heading}</p><ul style="margin:0;padding-left:18px;font-size:14px">${items.map((r) => `<li style="margin:3px 0">${line(r)}</li>`).join('')}</ul>` : '';
  const body = `<table style="border-collapse:collapse;width:100%"><tr>`
    + tile('Open', v.open.length, '#0f766e')
    + tile('Stale (7+ days)', v.stale.length, v.stale.length ? '#b91c1c' : '#0f766e')
    + `</tr></table>`
    + list('Waiting longest', v.oldest, (r) => `${esc(r.Item)} – ${esc(r.Account)}, ${r.days} days`);
  return shell(`Open action items – ${nice(v.n)}`, '#0f766e', body, sheetUrl, 'Sent weekly for every open action item logged from a call.');
}

if (typeof module !== 'undefined') {
  module.exports = { fromExtraction, ownerFor, buildRecap, actionItemRows, weeklyDigestText, weeklyDigestHtml, recapHtml };
}
