# RecapRelay (n8n)

Never let a call's follow-ups fall through — AI reads the meeting transcript, logs the recap and action items in
your CRM, and tells the owner immediately.

**Docs:** https://dakshvanshaj.com/recap-relay/

- [What it does and why](docs/index.md)
- [How it works](docs/how-it-works.md): the flow, the flags, the weekly digest
- [Set it up](docs/setup.md): run locally, credentials, test payloads, going live

Quick check of the rules: `node recap.test.js` should print `recap ok`.
Rebuild `workflow.json` after editing `recap.js`: `SHEET_ID=<id> WA_PHONE_ID=<id> node build.js`.
