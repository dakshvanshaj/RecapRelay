# Set it up

*You won't run any of this yourself if you hire me for it — this page is here so you (or your own dev team) can
see exactly what's involved, and so there's a clean reference when I set it up for your account.*

You need Docker and Node 18+, plus an Anthropic API key. Node is only used for the tests and `build.js`; n8n
itself runs in Docker.

## 1. Run n8n locally

```bash
docker run -d --name n8n -p 5678:5678 -e GENERIC_TIMEZONE=Asia/Kolkata -e TZ=Asia/Kolkata -v n8n_data:/home/node/.n8n -v "$PWD:/files" docker.n8n.io/n8nio/n8n
```

Open <http://localhost:5678> and create your login.

## 2. Google Sheet

Create a Sheet with three tabs:

**`Meetings`** — row 1 headers:
```text
Logged at, Meeting ID, Account, Contact, Team, Summary, Action items, Next step, Owner, Flags
```

**`Action Items`** — row 1 headers:
```text
Item ID, Meeting ID, Account, Item, Owner, Logged at, Status
```
Give `Status` a dropdown: `Open, Done`.

**`Settings`** — same sheet/pattern as CloseLoop and FirstReply, row 1 headers:
```text
Role, Team, Name, WhatsApp, Email
```
One row per team with `Role = Team Owner`, plus one `Role = Fallback Owner` row for anything unmatched.

Format every `Logged at` column as plain text (Format → Number → Plain text).

## 3. Credentials in n8n

- **Anthropic API:** add your API key as an HTTP Header Auth credential (header `x-api-key`), used by the
  **Extract with AI** node.
- **Google Sheets OAuth2 and Gmail OAuth2** (one OAuth client covers both; enable the Sheets, Drive and Gmail
  APIs): create an OAuth client in Google Cloud with redirect URI
  `http://localhost:5678/rest/oauth2-credential/callback`, then add the credential in n8n and sign in.
- **WhatsApp Business Cloud API:** add your access token credential. Sends are wired but need an approved
  message template and billing enabled on the Meta account to actually go out.
- **Webhook secret:** create a **Header Auth** credential named `Intake webhook secret`, header name
  `X-Intake-Secret`, long random value. Copy `.env.example` to `.env` with the same value.

## 4. Build, import, publish

```bash
SHEET_ID=<sheet id> WA_PHONE_ID=<whatsapp phone number id> node build.js
```

```bash
docker exec n8n n8n import:workflow --input=/files/workflow.json && docker exec n8n n8n publish:workflow --id=recapRelayMeetings1 && docker restart n8n
```

Open the workflow and pick your credentials on the webhook node, the Anthropic HTTP node, both Google Sheets
nodes, the Gmail nodes, and the WhatsApp nodes. Then publish.

## 5. Try it

```bash
./send-test.sh payloads/new-meeting.json
```

A row should appear in the Meetings sheet, two rows in Action Items, and a recap email should arrive. Mark one
action item `Done`, then send the same payload again — the Done status should survive.

To run the rule tests (no transcript or API key needed, since these feed the logic layer directly):
`node recap.test.js` should print `recap ok`.

## Going live with a real transcript source

**This is the one piece that's genuinely per-client**, since "how does a transcript reach this workflow" varies:

- **Zoom:** a webhook on the `recording.transcript_completed` event, with a step that pulls the transcript text
  and attaches the account/contact/rep/team your CRM or calendar already has for that meeting.
- **Google Meet / Teams:** usually via a transcription add-on (Fireflies, Otter, or the platform's own
  transcript) posting to this same webhook once a transcript is ready.
- **Any other source:** whatever gets you a `transcript` string plus the meeting's identifying metadata is
  enough — everything downstream of **Extract with AI** is already built and tested.
