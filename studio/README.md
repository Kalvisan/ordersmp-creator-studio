# OrderSMP Creator Studio

This is an AGPL modification of Postiz v2.25.1, with a private recording portal,
Google-only sign-in, creator isolation, reviewed scheduling and draft-only MCP.
The source of this modified network service is available in this repository.

Open `https://studio.ordersmp.net/` and sign in with an approved Google account.
The current exact email list is checked on every authenticated request;
invitations do not grant admission. Creators upload their own recordings, record
permission and credit, prepare clips and submit drafts. Only the configured
owner can connect official accounts and approve their exact destination,
words, media and time. TikTok stays a manual handoff until an approved route
is available. Native Postiz publication and native MCP cannot bypass approval.

## Deployment

The existing OrderSMP host owns the separate `ordersmp-creator` Docker project.
Run production operations through the Minecraft repository's `smp prod creator`
commands. The stack uses eight fixed service identities, private loopback
ports, read-only roots and explicit mounts. The aggregate ceiling is two CPU
cores and 10 GiB RAM; the one media worker is limited to half a core and 2 GiB.
Original uploads and unreviewed renders stay private. Public provider delivery
uses only approved, time-limited files at `ordersmp.net/creator-media/`.

Build the four custom targets using `.github/workflows/studio-build.yml`.
Use its resulting immutable GHCR digests with `studio/deploy/compose.mjs`.
Tags and the policy-test fixture are not deployment artifacts. The generator
contains no credentials. Upload each service's protected configuration and
secret files through the fixed installer, then validate, pull and start.
Do not change the game Docker daemon or restart Minecraft for this stack.

Postiz needs a separate database URL, Redis URL, JWT secret, dedicated Google
login client and owner email in its protected `service.env`. Login callback:
`https://studio.ordersmp.net/api/auth/google/callback`. Publishing credentials
are separate from this identity client. Keep secrets out of Git and arguments.
The gateway can start unbound for first login. After the owner signs in,
`smp prod creator owner-bootstrap` binds its real organisation and API key
through a private root-controlled transport. It creates no account or session.

Discord publishing uses a dedicated incoming webhook for the approved channel,
with the name `OrderSMP Notices` and its uploaded OrderSMP eye avatar. No second
server bot or Minecraft bot token is needed. Keep its URL in the gateway's
protected configuration and set the finite guild/channel allowlists. Each send
rechecks the reviewed destination and exact video bytes, disables mentions,
and records Discord's confirmed message ID. An unclear result needs owner
reconciliation. Attachments are limited to 10 MiB; prepare a smaller clip or
use an explicit manual handoff above that limit. Reading source-channel news
is a separate event integration, not a capability of an incoming webhook.

## Recording workflow

The public upload route accepts MP4, WebM or MKV files up to 90 MiB. Large VODs
still need a resumable upload path; the worker's 20 GiB internal limit does not
make those public uploads work. Storage admission is capped at 100 GiB,
including partial uploads and reserved renders. Supply
3–60 second ranges, or let the worker suggest up to three loud moments.
Suggestions require review; volume is not a judgement of story quality.
An already prepared 1080×1920 Short keeps its frame rate, up to 60 fps, while
the worker adds the required creator credit. New landscape clips keep the full game view
inside a portrait canvas. No face crop or platform watermark is added.

The base worker includes FFmpeg. Local transcription is disabled unless a
separately reviewed image includes faster-whisper and a provisioned local
model. It never downloads a model or calls a paid service during a job.
The trailer outro renderer is a separate editing tool, not an automatic step
for every creator's recording. Canonical artwork and font provenance are in
`STYLE.md`; the font's SIL licence is included with the asset.

## Verification

Use Node 22 and pnpm 10.6.1. Run the focused backend Jest configuration, the
native Node tests under `studio/portal` and `studio/publishing`, and the worker
Python unit tests. They cover denied identities, role/API bypasses, ownership,
changed content, revoked permissions, replay, private media, HTTP MCP and
uncertain publication. Mocked provider tests do not prove a live OAuth grant
or successful upload. Record Linux startup, public ingress, real Google sign-in,
provider grants, backup restoration and publication separately from local tests.
The first supplied-video batch is drafts only; registration is not API approval.
