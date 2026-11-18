#!/bin/sh
# Posts a sample meeting transcript to the local n8n webhook.
# Usage: ./send-test.sh [payloads/new-meeting.json]
cd "$(dirname "$0")" && . ./.env
curl -sS -w ' HTTP %{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -H "X-Intake-Secret: $INTAKE_SECRET" --data @"${1:-payloads/new-meeting.json}" \
  http://localhost:5678/webhook/new-meeting-transcript
