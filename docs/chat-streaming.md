# Streaming assistant

The device uses its existing bearer token and origin. Chat runs continue on the API server when a device disconnects, closes chat, or backgrounds. Reconnecting never repeats a model request or a tool. Stop is a separate authenticated action; losing the connection alone does not stop work.

## Protocol v1

All routes below have the `/api/v1` prefix and require the existing device bearer token.

- `POST /agent/conversations` with optional `{ "requestId": "UUID" }` creates a conversation idempotently.
- `POST /agent/conversations/:id/messages` accepts `{ "text": "...", "requestId": "UUID" }`. Send `Accept: text/event-stream` for streaming; older JSON callers receive the persisted assistant message after termination. Repeated request IDs return the original attempt. Changed text or conversation with the same ID is a conflict.
- `GET /agent/attempts/:id/events` subscribes/replays. Supply `Last-Event-ID: N` or `?after=N` (nonnegative decimal cursor). Only committed events after that cursor are sent.
- `POST /agent/attempts/:id/cancel` records Stop idempotently.
- `POST /agent/attempts/:id/retry` accepts a new `{ "requestId": "UUID" }`, with the same SSE negotiation. Retry is explicit and applies only to the latest failed/interrupted attempt. Keep that retry request ID when repeating an uncertain submission.
- `GET /agent/conversations/:id` returns messages, attempts, sanitized non-text events, and a cursor from one repeatable-read snapshot. Replace local content with the snapshot, then subscribe after its cursor. This prevents gaps or duplicate deltas.
- `GET /agent/compatibility` reports public model capability compatibility; it cannot determine account-specific provider permissions or credit balance.

Each SSE frame uses `id`, `event`, and JSON `data`, terminated by a blank line. IDs are monotonically increasing decimal strings, not timestamps. Heartbeats are SSE comments and have no ID. Payloads contain `version: 1`, `runId`, and `attemptId`.

| Event | Additional payload | Meaning |
| --- | --- | --- |
| `run.started` | `messageId`, optional `userMessageId` | Stable assistant identity; sending accepted |
| `text.delta` | `text` | Append text once, in cursor order |
| `tool.updated` | `step: {id,name,label,status,summary?}` | Actual pending/running/completed/failed/cancelled activity |
| `proposal.created` | `proposalId` | Unapplied draft available for review |
| `run.completed` | `status: completed` | Successful terminal event |
| `run.interrupted` | `status: interrupted`, `error` | Stop, timeout, or abandoned server work |
| `run.error` | `status: failed`, `error` | Provider/validation/other failure |

There is one terminal event per attempt. The stream then closes. EOF without a terminal event is a transport interruption: reload/reconnect rather than regenerate. Clients ignore duplicate IDs. The server sends no raw tool arguments/results, provider metadata, reasoning, or credentials. Errors have stable codes and user-safe messages, plus retry guidance where available.

## Persistence and execution

PostgreSQL owns runs, attempts, messages, events, pending tool calls, and tool results. Text flushes within 50 ms under normal database load; tool and terminal events commit before delivery. Slow subscribers are disconnected and replay from their last applied cursor without blocking model execution. Conversation snapshots include all messages; this private single-user implementation does not yet paginate long conversation archives.

The API permits one active attempt per conversation through a database index and transactional claims. A five-second heartbeat renews a 30-second lease. Expired attempts become interrupted and are never automatically executed again. Graceful shutdown interrupts owned attempts before database shutdown. Total work is bounded to five minutes, six rounds, and twelve tool calls per attempt; upstream connection/idle waits are 60 seconds. SSE heartbeats are emitted every 15 seconds and do not extend the work deadline.

Tool requests are assembled and validated before execution. Draft creation, result storage, proposal links, and checkpoint advancement commit together. Canonical validated tool name/arguments (including UUID case, defaults, optional nulls, and decimal formatting) identify a previously successful result within the logical user turn, including retries. Retry resumes saved pending calls/context; partial prose from an unfinished model round is preserved in its old assistant message, and that model round is regenerated into a new message. Read results already obtained within that turn are reused, so ask a new question to refresh them.

Stop aborts upstream HTTP where possible and blocks further dispatch. An already committing tool transaction completes and its draft remains available. OpenRouter provider support determines whether upstream processing/billing stops immediately. Applying a proposal remains exclusively the app's explicit review/apply action.

## OpenRouter compatibility

Keep `provider.require_parameters: true`, tool definitions, and strict JSON-schema extraction. Do not reintroduce `temperature` or `parallel_tool_calls`. Public metadata checked on 2026-09-05 lists neither for `openai/gpt-5.6-sol`. OpenAI endpoints advertise `max_tokens`, tools, response format, and structured outputs; Azure advertises `max_completion_tokens` instead, which narrows compatibility for the current `max_tokens` request. Do not change models or relax schema/tool requirements automatically.

A continued 404 can reflect an old deployed image, unsupported required parameters, provider restrictions, or no eligible endpoint. Check the sanitized compatibility endpoint, confirm the running image was rebuilt, and inspect account routing restrictions privately. Do not paste full provider metadata or `.env` into logs or tickets.

Synthetic smoke check on the VPS (sends no portfolio data and executes no finance tool):

```sh
docker compose exec api node dist/modules/agent/smoke.js
```

The command verifies tool output plus a synthetic image against the actual strict import schema, printing only validation status and sanitized errors. It uses the deployment's configured models/key and makes up to two bounded paid model calls. Public capabilities are not proof that a particular account can route.

## VPS rebuild using the existing tunnel

From the project checkout containing the updated files and private `.env`:

```sh
make backup
docker compose build api worker migrate
docker compose stop api worker
docker compose run --rm migrate
docker compose up -d api worker caddy
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
docker compose ps
```

The explicit reload applies the mounted Caddy configuration even when Compose reuses its container. If migration fails, leave API/worker stopped, fix the reported migration problem, then rerun migration and startup. Do not downgrade the application over incompatible schema changes. Use the existing documented backup/restore procedure only after checking the target and backup.

Caddy excludes agent routes from compression and uses `flush_interval -1`. The API sends `text/event-stream`, `Cache-Control: no-store, no-transform`, and `X-Accel-Buffering: no`. Keep any existing Cloudflare cache rules from overriding these headers. The same existing hostname and named Cloudflare Tunnel carry SSE; no additional tunnel is needed. The repository contains no tunnel configuration, so verify the deployed tunnel type. Cloudflare Quick Tunnels do not support SSE; an existing Quick Tunnel cannot satisfy this protocol.

Check health, then verify incremental delivery through the existing public hostname. Set `FINANCE_ORIGIN`, `FINANCE_DEVICE_TOKEN`, `CONVERSATION_ID`, and a new `CHAT_REQUEST_ID` locally; keep shell tracing off and never put the token in a URL. Use the conversation-create route above to obtain a conversation ID.

```sh
curl --fail-with-body "$FINANCE_ORIGIN/health"
curl -N --no-buffer --max-time 330 \
  -H "Authorization: Bearer $FINANCE_DEVICE_TOKEN" \
  -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' \
  --data "{\"requestId\":\"$CHAT_REQUEST_ID\",\"text\":\"Summarize my accounts without proposing changes.\"}" \
  "$FINANCE_ORIGIN/api/v1/agent/conversations/$CONVERSATION_ID/messages"
```

Expect `run.started` immediately, periodic heartbeat comments during slow work, incremental text/tool events, and one terminal event. Disconnect curl, reload the conversation, and replay using the saved cursor; confirm there is one user message. Stop through the cancel endpoint and verify drafts remain unapplied. Test through the public hostname as well as the origin to detect buffering along the existing tunnel path.

Sources: [OpenRouter streaming](https://openrouter.ai/docs/api/reference/streaming), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Validation evidence (2026-09-05)

- Node 24 Docker build and isolated PostgreSQL/Redis suite: 94 tests passed, including real authenticated HTTP SSE, disconnect/replay, graceful shutdown, fragmented UTF-8/tool calls, safe provider errors, draft deduplication, and Stop while a draft transaction commits.
- Swift unit suite: 31 tests passed, including parser framing, event deduplication, stale callback suppression, offline restoration, and a lost retry acknowledgement recovered through its persisted request ID.
- Three deterministic iOS 26.5 simulator UI tests passed: long streaming Markdown and scrolling, Stop/retry/reopen with independent server work, and dark mode at accessibility text sizes. Screenshots are local under `docs/screenshots/chat/` (ignored by Git).
- Caddy 2.10.2 configuration validation passed without network access.
- The Mac's host Node is 23.9; authoritative backend build/integration execution uses the repository's Node 24 Docker image. Xcode 27 beta compiled against the installed iOS 26.5 simulator with iOS 26 deployment target.
- Live synthetic OpenRouter requests could not execute: this checkout's `.env` has no configured models/key. Public endpoint capabilities were checked separately; actual account routing, credits, and provider behavior require the VPS smoke command above.
- No VPS/tunnel configuration was supplied, so production rebuild, existing named-tunnel delivery, and physical-device behavior were not exercised. No push or deployment was performed during validation.

The transcript uses a regular SwiftUI stack with stable message IDs. The previous lazy container caused a reproducible rich-text layout loop while a large accessibility-size message grew; the regular stack and fixed vertical text sizing passed the same fixture. Large conversation archives are not yet paginated. Package versions are pinned in `ios/project.yml`, and `make ios-generate` restores the tracked `ios/Package.resolved` into the generated project.
