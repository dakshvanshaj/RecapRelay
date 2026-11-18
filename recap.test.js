// Run: node recap.test.js
const assert = require('node:assert/strict');
const { fromExtraction, ownerFor, buildRecap, actionItemRows, weeklyDigestText, weeklyDigestHtml, recapHtml } = require('./recap.js');

const base = {
  meeting_id: 'zoom-9981', account: 'Acme Supplies', contact: 'Priya Rao', rep: 'Daksh',
  team: 'Enterprise', summary: 'Discussed renewal terms and rollout timeline.',
  action_items: [{ text: 'Send updated proposal', owner: 'us' }, { text: 'Confirm budget sign-off', owner: 'Priya' }],
  next_step: 'Follow-up call Mon Nov 24', risks: [],
};
const settings = [{ Role: 'Team Owner', Team: 'Enterprise', Name: 'Sam', WhatsApp: '', Email: 'sam@example.com' }];

// fromExtraction normalisation
const D = fromExtraction(base);
assert.equal(D.meetingId, 'zoom-9981');
assert.equal(D.actionItems.length, 2);
assert.equal(D.actionItems[0].text, 'Send updated proposal');
assert.equal(fromExtraction({ action_items: [{ text: '' }, { item: 'Call back' }] }).actionItems.length, 1); // blank items dropped, item fallback used
assert.equal(fromExtraction({}).risks.length, 0);

// ownerFor: same Settings-sheet pattern as the other templates
assert.deepEqual(ownerFor('Enterprise', settings), { Name: 'Sam', WhatsApp: '', Email: 'sam@example.com' });
assert.equal(ownerFor('Nobody', settings), null);

// buildRecap: ok case
const now = new Date('2026-11-10T10:00:00+05:30');
const ok = buildRecap(D, now, settings, null);
assert.equal(ok.row.Flags, '');
assert.equal(ok.row.Account, 'Acme Supplies');
assert.equal(ok.row.Owner, 'Sam');
assert.equal(ok.email, 'sam@example.com');
assert.equal(ok.subject, 'Meeting recap: Acme Supplies – Priya Rao');
assert.deepEqual(Object.keys(ok.row), ['Logged at', 'Meeting ID', 'Account', 'Contact', 'Team', 'Summary', 'Action items', 'Next step', 'Owner', 'Flags']);

// missing fields
const missing = buildRecap(fromExtraction({ ...base, account: '', summary: '' }), now, settings, null);
assert.match(missing.row.Flags, /Missing: account\/deal name, meeting summary/);
assert.match(missing.subject, /^⚠ Meeting recap/);

// no action items captured
const noItems = buildRecap(fromExtraction({ ...base, action_items: [] }), now, settings, null);
assert.match(noItems.row.Flags, /No action items captured/);

// risk flag surfaces
const risky = buildRecap(fromExtraction({ ...base, risks: ['Mentioned a competitor', 'Budget freeze until Q2'] }), now, settings, null);
assert.match(risky.row.Flags, /Risk flagged: Mentioned a competitor, Budget freeze until Q2/);

// no owner set for the team
const noOwner = buildRecap(fromExtraction({ ...base, team: 'Ghost Team' }), now, settings, null);
assert.match(noOwner.row.Flags, /No owner set for team Ghost Team/);
assert.equal(noOwner.row.Owner, 'Daksh'); // falls back to the rep on the call

// update keeps first logged time
const prevRow = { 'Logged at': '2026-11-01 09:00', 'Meeting ID': 'zoom-9981', Account: 'Acme Supplies' };
const upd = buildRecap(D, now, settings, prevRow);
assert.equal(upd.row['Logged at'], '2026-11-01 09:00');
assert.equal(upd.updated, true);

// actionItemRows: a human's Done mark survives a re-processed meeting
const first = actionItemRows(D, now, []);
assert.equal(first.length, 2);
assert.equal(first[0].Status, 'Open');
const marked = first.map((r, i) => (i === 0 ? { ...r, Status: 'Done' } : r));
const reprocessed = actionItemRows(fromExtraction({ ...base, action_items: [{ text: 'Send updated proposal (v2)', owner: 'us' }, { text: 'Confirm budget sign-off', owner: 'Priya' }] }), now, marked);
assert.equal(reprocessed[0].Status, 'Done'); // survives even though the text changed
assert.equal(reprocessed[0].Item, 'Send updated proposal (v2)');
assert.equal(reprocessed[0]['Logged at'], marked[0]['Logged at']); // first-logged time also preserved
assert.equal(reprocessed[1].Status, 'Open');

// weekly digest: stale counting and ordering
const items = [
  { 'Item ID': 'a-1', Item: 'Old one', Account: 'Acme', 'Logged at': '2026-11-01 09:00', Status: 'Open' },
  { 'Item ID': 'a-2', Item: 'Newer one', Account: 'Acme', 'Logged at': '2026-11-09 09:00', Status: 'Open' },
  { 'Item ID': 'a-3', Item: 'Done one', Account: 'Acme', 'Logged at': '2026-10-01 09:00', Status: 'Done' },
];
const text = weeklyDigestText(items, now, 'https://sheet');
assert.match(text, /Open: 2/);
assert.match(text, /Stale \(7\+ days\): 1/);
assert.match(text, /Old one \(Acme\), 9 days/);
assert.doesNotMatch(text, /Done one/);

// HTML + XSS escaping + source link + action items list
const docWithSource = fromExtraction({ ...base, source_url: 'https://zoom.us/rec/abc' });
const h1 = recapHtml(buildRecap(docWithSource, now, settings, null), docWithSource, 'https://sheet');
assert.match(h1, /Acme Supplies/); assert.match(h1, /View the recording\/transcript/); assert.match(h1, /Send updated proposal/);
const evilDoc = fromExtraction({ ...base, account: '<script>x</script>' });
const h2 = recapHtml(buildRecap(evilDoc, now, settings, null), evilDoc, 'https://sheet');
assert.doesNotMatch(h2, /<script>/); assert.match(h2, /&lt;script&gt;/);
assert.doesNotMatch(recapHtml(buildRecap(D, now, settings, null), D, 'https://sheet'), /View the recording/); // no source link when none given
assert.match(weeklyDigestHtml(items, now, 'https://sheet'), /Stale \(7\+ days\)/);

console.log('recap ok');
