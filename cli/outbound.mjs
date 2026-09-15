#!/usr/bin/env node
/**
 * outbound — CLI for the shared prospect database.
 *
 * Designed to chain. Every read can emit bare ids (--ids) or JSON (--json),
 * and every write accepts ids on stdin, so a whole workflow is one shell
 * pipeline instead of one round-trip per record:
 *
 *   outbound list --stage=replied --ids | outbound set --stage=meeting
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'outbound', 'config.json');

const die = (msg, code = 1) => { process.stderr.write(`outbound: ${msg}\n`); process.exit(code); };

// ---------------------------------------------------------------- config

const loadConfig = () => (existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {});

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, ...rest] = arg.slice(2).split('=');
      flags[k] = rest.length ? rest.join('=') : true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

// ---------------------------------------------------------------- auth

let cachedCfToken = null;

const isLocal = (api) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(api || '');

function authHeaders(cfg) {
  // `wrangler dev` has no Access in front of it; wrangler.jsonc supplies the identity.
  if (isLocal(cfg.api)) return {};

  const id = process.env.OUTBOUND_CLIENT_ID || cfg.client_id;
  const secret = process.env.OUTBOUND_CLIENT_SECRET || cfg.client_secret;

  // Service token — what agents and cron jobs use.
  if (id && secret) return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };

  // Otherwise fall back to the human's cloudflared session (Google SSO).
  if (cachedCfToken === null) {
    try {
      cachedCfToken = execFileSync('cloudflared', ['access', 'token', `-app=${cfg.api}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { cachedCfToken = ''; }
  }
  if (cachedCfToken) return { 'cf-access-token': cachedCfToken };

  die('not authenticated. Run `outbound login`, or set OUTBOUND_CLIENT_ID / OUTBOUND_CLIENT_SECRET for a service token.');
}

// ---------------------------------------------------------------- http

async function api(path, { method = 'GET', body, cfg } = {}) {
  if (!cfg.api) die('no API url configured. Run: outbound config <https://your-worker-url>');
  const res = await fetch(cfg.api.replace(/\/$/, '') + path, {
    method,
    headers: { ...authHeaders(cfg), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 400) }; }

  if (!res.ok && res.status !== 207) {
    if (res.status === 401) {
      die(`${data.error || 'unauthorized'}\n  -> run \`outbound login\`, or check your service token.`);
    }
    die(`${res.status} ${data.error || res.statusText}`, res.status === 409 ? 2 : 1);
  }
  return data;
}

// ---------------------------------------------------------------- io

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** ids from argv, else from stdin — bare lines or JSON with .id fields. */
async function resolveIds(positional) {
  if (positional.length) return positional;
  const raw = (await readStdin()).trim();
  if (!raw) return [];
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((r) => r.id).filter(Boolean);
  }
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift().map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows, cols) {
  const keys = cols || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [keys.join(','), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(','))].join('\n');
}

const ago = (iso) => {
  if (!iso) return 'never';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? 'today' : `${d}d`;
};

function table(rows, cols) {
  if (!rows.length) { process.stderr.write('no matching prospects\n'); return; }
  const w = cols.map((c) => Math.max(c.label.length,
    ...rows.map((r) => String(c.get(r) ?? '').length)));
  const line = (cells) => cells.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ').trimEnd();
  console.log(line(cols.map((c) => c.label)));
  console.log(line(w.map((n) => '-'.repeat(n))));
  for (const r of rows) console.log(line(cols.map((c) => c.get(r))));
}

/** Emit a result set honouring --json / --ids / default table. */
function emit(rows, flags, cols) {
  if (flags.ids) { for (const r of rows) console.log(r.id); return; }
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (flags.csv) { console.log(toCsv(rows)); return; }
  table(rows, cols);
}

/** Columns for an arbitrary result set, e.g. whatever `outbound sql` returned. */
const dynamicCols = (rows) =>
  [...new Set(rows.flatMap((r) => Object.keys(r)))].map((k) => ({
    label: k.toUpperCase(),
    get: (r) => {
      const v = r[k];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.length > 40 ? s.slice(0, 37) + '...' : s;
    },
  }));

const LIST_COLS = [
  { label: 'ID', get: (r) => r.id },
  { label: 'COMPANY', get: (r) => (r.company || '').slice(0, 28) },
  { label: 'CONTACT', get: (r) => (r.contact_name || r.contact_email || '').slice(0, 26) },
  { label: 'STAGE', get: (r) => r.stage },
  { label: 'OWNER', get: (r) => (r.owner || '').split('@')[0] },
  { label: 'TOUCH', get: (r) => ago(r.last_touch_at) },
  { label: 'NEXT', get: (r) => r.next_action_at || '' },
];

// ---------------------------------------------------------------- commands

const FIELD_FLAGS = {
  company: 'company', domain: 'domain', name: 'contact_name', email: 'contact_email',
  title: 'contact_title', linkedin: 'linkedin', source: 'source', owner: 'owner',
  stage: 'stage', 'next-action': 'next_action', due: 'next_action_at', notes: 'notes',
};

const fieldsFromFlags = (flags) => Object.fromEntries(
  Object.entries(FIELD_FLAGS)
    .filter(([f]) => flags[f] !== undefined && flags[f] !== true)
    .map(([f, col]) => [col, flags[f]]),
);

/** Everything an agent needs in one read, with the schema fetched live so it can't go stale. */
const agentBrief = (s, me, cfg) => `# outbound — CRM contract for agents

You are ${me.id} (${me.kind}) against ${cfg.api}.

## Schema
${s.tables.map((t) => `${t.table}(${t.columns.map((c) => c.name).join(', ')})`).join('\n')}

stages:   ${s.stages.join(' ')}
channels: ${s.channels.join(' ')}

## Composition — the reason this is a CLI and not an MCP server
Reads emit ids with --ids, or JSON with --json. Writes take ids from argv, or from
stdin when none are given. So a whole workflow is one bash call, not one call per row:

  outbound list --stage=replied --ids | outbound set --stage=meeting
  outbound list --stale=14 --owner=sam --ids | outbound touch --channel=email --note=bump
  outbound sql "SELECT id FROM prospects WHERE domain LIKE '%.ai'" --ids | outbound set --owner=sam

Counts go to stderr, ids to stdout, so pipes stay clean. Non-zero exit on failure;
exit 2 specifically means a write was refused as stale.

## SQL
  outbound sql "SELECT stage, COUNT(*) FROM prospects GROUP BY stage"
  outbound sql "UPDATE prospects SET owner = 'sam' WHERE owner IS NULL" --write

Reads are free. Anything that modifies data needs --write. DDL is rejected — the
schema belongs to the developers and changes through migrations, not through you.
One statement per call.

## Writing safely
Other agents and three humans share this database. There are no transactions.

- Creating a lead that may already exist: use --upsert. It dedupes on contact_email
  and merges only the fields you pass, so it will not overwrite an existing owner.
- Read-modify-write: pass --expect-rev=N from the row you read. If someone wrote
  first the call fails with exit 2 instead of silently clobbering them. Re-read and retry.
- Bulk work: prefer one SQL statement over a loop of updates.
- Stay in your lane: filter by --owner when you can, so two agents do not collide.

## Do not
- Do not invent stages. The list above is the whole set.
- Do not delete rows unless explicitly asked; prefer --stage=passed.
- Do not put secrets in notes. Everything here is visible to the whole team.
`;

const HELP = `outbound — shared CRM for the team

  AGENTS: run \`outbound agent\` for the full contract — live schema, composition
  rules, and the concurrency rules for writing alongside other agents. One read,
  everything you need. This page is the short version.

SETUP
  outbound config <api-url>       point the CLI at the Worker
  outbound login                  humans: sign in via Cloudflare Access (Google)
  outbound whoami                 who the API thinks you are
                                  agents: set OUTBOUND_CLIENT_ID / _SECRET instead

READ
  outbound list [filters]         --stage= --owner= --q= --domain= --source=
                                  --stale=N  (nothing logged in N days)
                                  --due      (next action is due)
  outbound show <id>              one record, with its touch history
  outbound stats                  counts by stage
  outbound schema                 tables, columns, valid stages and channels
  outbound export [--csv]

WRITE
  outbound add <company> [--email=] [--name=] [--owner=] [--stage=] [--source=] [--upsert]
  outbound set [ids...]  [--stage=] [--owner=] [--next-action=] [--due=] [--expect-rev=N]
  outbound touch [ids...] --channel=email|linkedin|call|meeting|other [--note=] [--in]
  outbound rm [ids...]
  outbound import [--csv|--json] [--upsert]      reads stdin

SQL
  outbound sql "SELECT stage, COUNT(*) FROM prospects GROUP BY stage"
  outbound sql "UPDATE prospects SET owner='sam' WHERE owner IS NULL" --write
                                  reads are free; changing data needs --write

OUTPUT
  --json   full JSON        --ids   bare ids, one per line        --csv

CHAINING — ids come from arguments, or from stdin when none are given
  outbound list --stage=replied --ids | outbound set --stage=meeting
  outbound list --stale=14 --ids | outbound touch --channel=email --note=bump
  outbound sql "SELECT id FROM prospects WHERE domain LIKE '%.ai'" --ids | outbound set --owner=sam

WRITING ALONGSIDE OTHERS
  --upsert        dedupe on email; merges only the fields you pass
  --expect-rev=N  refuse the write (exit 2) if someone changed the row first
`;

async function main() {
  // Flags may appear anywhere, including before the command.
  const { flags, positional: argv } = parseArgs(process.argv.slice(2));
  const cmd = argv[0];
  const positional = argv.slice(1);
  const cfg = { ...loadConfig(), ...(flags.api ? { api: flags.api } : {}) };

  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(HELP); return;

    case 'config': {
      if (!positional[0]) { console.log(JSON.stringify({ ...loadConfig(), client_secret: loadConfig().client_secret ? '***' : undefined }, null, 2)); return; }
      const next = saveConfig({ api: positional[0].replace(/\/$/, '') });
      console.log(`api set to ${next.api}`); return;
    }

    case 'login': {
      if (!cfg.api) die('set the API url first: outbound config <url>');
      try {
        execFileSync('cloudflared', ['access', 'login', cfg.api], { stdio: 'inherit' });
      } catch {
        die('cloudflared failed. Install it with `brew install cloudflared`.');
      }
      cachedCfToken = null;
      const me = await api('/api/whoami', { cfg });
      console.log(`signed in as ${me.id}`); return;
    }

    case 'whoami': console.log(JSON.stringify(await api('/api/whoami', { cfg }), null, 2)); return;

    case 'sql': {
      const q = positional.join(' ').trim() || (await readStdin()).trim();
      if (!q) die('usage: outbound sql "SELECT * FROM prospects WHERE stage = \'replied\'"');
      const res = await api(`/api/sql${flags.write ? '?write=1' : ''}`, { method: 'POST', body: { sql: q }, cfg });
      if (flags.json) { console.log(JSON.stringify(res.rows, null, 2)); return; }
      if (flags.ids) { for (const r of res.rows) console.log(r.id ?? Object.values(r)[0]); return; }
      if (flags.csv) { console.log(toCsv(res.rows)); return; }
      if (res.wrote) { process.stderr.write(`${res.changes} row${res.changes === 1 ? '' : 's'} changed\n`); return; }
      table(res.rows, dynamicCols(res.rows));
      return;
    }

    case 'schema': {
      const s = await api('/api/schema', { cfg });
      if (flags.json) { console.log(JSON.stringify(s, null, 2)); return; }
      for (const t of s.tables) {
        console.log(t.table);
        for (const c of t.columns) {
          const bits = [c.type || 'ANY', c.pk ? 'primary key' : '', c.notnull ? 'not null' : '']
            .filter(Boolean).join(', ');
          console.log(`  ${c.name.padEnd(16)} ${bits}`);
        }
        console.log('');
      }
      console.log(`stages:   ${s.stages.join(' ')}`);
      console.log(`channels: ${s.channels.join(' ')}`);
      return;
    }

    case 'agent': {
      const s = await api('/api/schema', { cfg });
      const me = await api('/api/whoami', { cfg });
      console.log(agentBrief(s, me, cfg));
      return;
    }

    case 'stats': {
      const s = await api('/api/stats', { cfg });
      if (flags.json) { console.log(JSON.stringify(s, null, 2)); return; }
      console.log(`${s.total} prospects`);
      for (const r of s.by_stage) console.log(`  ${String(r.n).padStart(5)}  ${r.stage}`);
      return;
    }

    case 'add': {
      const body = fieldsFromFlags(flags);
      if (positional[0]) body.company = positional[0];
      if (!body.company) die('usage: outbound add <company> [--email=...]');
      const row = await api(`/api/prospects${flags.upsert ? '?upsert=1' : ''}`, { method: 'POST', body, cfg });
      console.log(flags.json ? JSON.stringify(row, null, 2) : row.id); return;
    }

    case 'list': case 'export': {
      const q = new URLSearchParams();
      for (const k of ['stage', 'owner', 'q', 'domain', 'source', 'stale', 'limit', 'offset']) {
        if (flags[k] && flags[k] !== true) q.set(k, flags[k]);
      }
      if (flags.due) q.set('due', '1');
      if (cmd === 'export') q.set('limit', '1000');
      const rows = await api(`/api/prospects?${q}`, { cfg });
      if (cmd === 'export' && !flags.json) { console.log(toCsv(rows)); return; }
      emit(rows, flags, LIST_COLS); return;
    }

    case 'show': {
      if (!positional[0]) die('usage: outbound show <id>');
      const row = await api(`/api/prospects/${positional[0]}`, { cfg });
      if (flags.json) { console.log(JSON.stringify(row, null, 2)); return; }
      for (const [k, v] of Object.entries(row)) {
        if (k === 'touches' || v === null) continue;
        console.log(`${k.padEnd(15)} ${v}`);
      }
      if (row.touches?.length) {
        console.log('\ntouches');
        for (const t of row.touches) {
          console.log(`  ${t.occurred_at.slice(0, 10)}  ${t.direction === 'in' ? '<-' : '->'} ${t.channel.padEnd(9)} ${t.note || ''}  (${t.author})`);
        }
      }
      return;
    }

    case 'set': {
      const body = fieldsFromFlags(flags);
      if (!Object.keys(body).length) die('nothing to set. Try --stage=, --owner=, --next-action=');
      const ids = await resolveIds(positional);
      if (!ids.length) die('no ids given, on the command line or stdin');
      const qs = flags['expect-rev'] ? `?expect_rev=${flags['expect-rev']}` : '';
      const out = [];
      for (const id of ids) out.push(await api(`/api/prospects/${id}${qs}`, { method: 'PATCH', body, cfg }));
      if (flags.json) console.log(JSON.stringify(out, null, 2));
      else process.stderr.write(`updated ${out.length}\n`);
      for (const r of out) if (!flags.json) console.log(r.id);
      return;
    }

    case 'touch': {
      const ids = await resolveIds(positional);
      if (!ids.length) die('no ids given, on the command line or stdin');
      const body = {
        channel: flags.channel === true || !flags.channel ? 'other' : flags.channel,
        note: flags.note === true ? null : flags.note,
        direction: flags.in ? 'in' : 'out',
      };
      for (const id of ids) await api(`/api/prospects/${id}/touches`, { method: 'POST', body, cfg });
      process.stderr.write(`logged ${ids.length} touch${ids.length === 1 ? '' : 'es'}\n`);
      for (const id of ids) console.log(id);
      return;
    }

    case 'rm': {
      const ids = await resolveIds(positional);
      if (!ids.length) die('no ids given, on the command line or stdin');
      for (const id of ids) await api(`/api/prospects/${id}`, { method: 'DELETE', cfg });
      process.stderr.write(`deleted ${ids.length}\n`);
      return;
    }

    case 'import': {
      const raw = (await readStdin()).trim();
      if (!raw) die('nothing on stdin. Try: outbound import --csv < leads.csv');
      const rows = flags.csv || (!flags.json && !raw.startsWith('[')) ? parseCsv(raw) : JSON.parse(raw);
      if (!rows.length) die('no rows parsed from stdin');
      const results = await api(`/api/prospects${flags.upsert ? '?upsert=1' : ''}`, { method: 'POST', body: rows, cfg });
      const ok = results.filter((r) => r.status < 300);
      process.stderr.write(`imported ${ok.length}/${results.length}\n`);
      for (const r of results.filter((x) => x.status >= 300)) {
        process.stderr.write(`  skipped: ${r.body.error}\n`);
      }
      for (const r of ok) console.log(r.body.id);
      return;
    }

    default: die(`unknown command "${cmd}". Run \`outbound help\`.`);
  }
}

main().catch((e) => die(e.message));
