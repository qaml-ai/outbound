# outbound

A shared outbound-prospect database for a small team. Cloudflare Worker + D1 behind
Cloudflare Access, with a CLI built to be piped.

The point is that a whole workflow is one shell pipeline, not one round-trip per record:

```bash
outbound list --stage=replied --ids | outbound set --stage=meeting
outbound list --stale=14 --owner=miguel --ids | outbound touch --channel=email --note="bump"
```

Reads emit bare ids (`--ids`) or JSON (`--json`); writes take ids from argv or stdin. So
anything `jq` can express is a valid query, and agents can chain work in a single bash
call instead of a tool call per row.

## Why this shape

- **D1** is cheap (5M row reads/day free, $5/mo Workers Paid) and a prospect list is tiny.
- **Cloudflare Access** does the auth. The Worker never sees a password and stores no
  users — Access authenticates, and the Worker reads the result off `ctx.access`.
- **A CLI, not an MCP server**, because bash composes and MCP tool calls don't. Agents
  get `outbound list ... | outbound set ...` in one call. The Worker API is plain JSON,
  so an MCP wrapper can go on top later without changing anything underneath.

## Setup

```bash
npm install
npx wrangler d1 create outbound          # put the id in wrangler.jsonc
npm run db:remote                        # apply schema
npm run deploy
```

Then put Access in front of the Worker (see [docs/access.md](docs/access.md)) and point
the CLI at it:

```bash
npm link                                 # or: alias outbound="node /path/to/cli/outbound.mjs"
outbound config https://outbound.<subdomain>.workers.dev
outbound login                           # browser, Google SSO — humans
outbound whoami
```

Agents and cron jobs skip `login` and use an Access **service token** instead:

```bash
export OUTBOUND_CLIENT_ID=...            # from Zero Trust -> Access -> Service Tokens
export OUTBOUND_CLIENT_SECRET=...
```

The CLI also reads `~/.config/outbound/config.json` (mode 600) for `api`, `client_id`,
and `client_secret`, so the env vars are optional.

## Commands

```
outbound add <company> [--email=] [--name=] [--owner=] [--stage=] [--source=] [--upsert]
outbound list [--stage=] [--owner=] [--q=] [--domain=] [--source=] [--stale=N] [--due]
outbound show <id>
outbound set [ids...] [--stage=] [--owner=] [--next-action=] [--due=] [--expect-rev=N]
outbound touch [ids...] --channel=email|linkedin|call|meeting|other [--note=] [--in]
outbound rm [ids...]
outbound import [--csv|--json] [--upsert]      # stdin
outbound export [--csv]
outbound stats
```

Output flags: `--json`, `--ids`, `--csv`. Ids come from arguments, or from stdin when
none are given.

Stages: `new researching queued contacted replied meeting opportunity won lost passed`

## Two agents writing at once

Neither SQLite nor this API has transactions across requests, so two writers racing the
same record is a real failure mode rather than a theoretical one. Two guards:

**Dedupe on email.** `--upsert` turns an insert into an upsert keyed on `contact_email`,
so two agents discovering the same lead converge on one row instead of creating twins.
It merges only the fields you actually sent — it will not overwrite an existing `owner`
with a default.

```bash
outbound add "Acme" --email=jane@acme.com --title="VP Eng" --upsert
```

**Optimistic concurrency.** Every row carries a `rev` that increments on write. Pass
`--expect-rev` and the write is refused (exit 2) if someone got there first:

```bash
$ outbound set 939530f8530d48ad --stage=won --expect-rev=1
outbound: 409 prospect 939530f8530d48ad was modified by sam@example.com (rev 2, you expected 1)
```

Without `--expect-rev` it is last-write-wins, which is fine for a human typing but not
for an agent doing read-modify-write. Partition agent work by `--owner` and you mostly
avoid the question.

Every row also records `updated_by` and `updated_at`, so collisions are at least
attributable after the fact.

## Local development

```bash
npm run db:local
npx wrangler dev
outbound --api=http://127.0.0.1:8788 list
```

`wrangler.jsonc` has an `access.dev` block that supplies a fake identity locally, since
Access isn't in front of `wrangler dev`. The CLI skips auth headers for localhost.

## API

All routes need Access. `GET /api/health`, `GET /api/whoami`, `GET /api/stats`,
`GET|POST /api/prospects`, `GET|PATCH|DELETE /api/prospects/:id`,
`GET|POST /api/prospects/:id/touches`. `POST /api/prospects` accepts an array for bulk
import and returns 207 with per-row results.
