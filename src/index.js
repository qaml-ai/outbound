/**
 * outbound — shared prospect database API.
 *
 * Auth is Cloudflare Access, enabled on the Worker itself (see README). Access
 * runs before our code and hands us an already-verified identity on `ctx.access`,
 * so there is no JWT to parse and no JWKS to cache. A missing `ctx.access` means
 * Access did not run, which we refuse rather than guess at.
 */

import CLI_SOURCE from '../cli/outbound.mjs';

const STAGES = [
  'new', 'researching', 'queued', 'contacted',
  'replied', 'meeting', 'opportunity', 'won', 'lost', 'passed',
];

const CHANNELS = ['email', 'linkedin', 'call', 'meeting', 'other'];

const WRITABLE = [
  'company', 'domain', 'contact_name', 'contact_email', 'contact_title',
  'linkedin', 'source', 'owner', 'stage', 'next_action', 'next_action_at', 'notes',
];

// ---------------------------------------------------------------- helpers

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const fail = (status, message, extra = {}) => json({ error: message, ...extra }, status);

const now = () => new Date().toISOString();

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

const norm = (v) => (v === undefined || v === null || v === '' ? null : String(v).trim());

// ---------------------------------------------------------------- sql

const READ_VERBS = ['select', 'with', 'explain', 'pragma'];
const WRITE_VERBS = ['insert', 'update', 'delete', 'replace'];

/**
 * Decide what a statement does, so reads can be free and writes deliberate.
 * String literals and comments are blanked first so a quote or a `--` cannot
 * hide the real verb or a second statement.
 */
function classifySql(sql) {
  const bare = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();

  if (/;\s*\S/.test(bare)) {
    return { error: 'one statement at a time — split these into separate calls' };
  }

  const verb = (bare.match(/^([a-z]+)/i)?.[1] || '').toLowerCase();
  if (!verb) return { error: 'could not parse a statement' };

  if (READ_VERBS.includes(verb)) return { verb, writes: false };
  if (WRITE_VERBS.includes(verb)) return { verb, writes: true };

  return {
    error: `"${verb}" is not allowed here — schema changes go through migrations `
      + '(npx wrangler d1 migrations), not the API',
  };
}

// ---------------------------------------------------------------- install

/**
 * `curl -fsSL <worker>/install | sh`. Served without Access (see docs/access.md)
 * so a new machine can bootstrap before it has credentials. Nothing secret is in
 * here — the CLI is public on GitHub — and the API url is baked in from our own
 * origin so nobody has to be told what it is.
 */
const INSTALL_SH = `#!/bin/sh
set -e

API="__ORIGIN__"
BIN="$HOME/.local/bin"
CFG="$HOME/.config/outbound"

printf 'installing outbound from %s\\n' "$API"

if ! command -v node >/dev/null 2>&1; then
  echo "outbound needs node 18+ (try: brew install node)" >&2
  exit 1
fi

mkdir -p "$BIN" "$CFG"
curl -fsSL "$API/cli" -o "$BIN/outbound"
chmod +x "$BIN/outbound"

# Record the API url without clobbering any credentials already there.
if [ -f "$CFG/config.json" ]; then
  node -e 'const fs=require("fs"),p=process.argv[1],c=JSON.parse(fs.readFileSync(p,"utf8"));c.api=process.argv[2];fs.writeFileSync(p,JSON.stringify(c,null,2)+"\\n")' "$CFG/config.json" "$API"
else
  printf '{\\n  "api": "%s"\\n}\\n' "$API" > "$CFG/config.json"
fi
chmod 600 "$CFG/config.json"

echo "installed $BIN/outbound"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo ""
     echo "$BIN is not on your PATH. Add it:"
     echo "  echo 'export PATH=\\"\\$HOME/.local/bin:\\$PATH\\"' >> ~/.zshrc && exec zsh" ;;
esac

echo ""
echo "next:"
echo "  outbound login     # humans, opens a browser"
echo "  outbound agent     # agents, prints the full contract"
`;

// ---------------------------------------------------------------- identity

/**
 * Who is calling. Access verifies the request before our code runs and exposes
 * the result on `ctx.access`; `undefined` means it never ran, which would mean
 * the Worker is sitting unprotected.
 *
 * Humans get an email from getIdentity(). Service tokens get nothing there —
 * for them `ctx.access` carries only `aud` — so we read the common name off the
 * assertion Access injects.
 *
 * That read is deliberately unverified: `ctx.access` existing is already proof
 * Access authenticated this request, and Access strips any client-supplied copy
 * of its own headers before we see them. We are labelling an actor we have
 * already authenticated, not deciding whether to trust it.
 */
async function identify(request, ctx) {
  if (!ctx.access) {
    throw Object.assign(
      new Error('Cloudflare Access did not authenticate this request — is Access enabled on this Worker?'),
      { status: 401 },
    );
  }

  const identity = await ctx.access.getIdentity();
  if (identity?.email) return { id: identity.email, kind: 'user' };

  const claims = readAssertion(request.headers.get('cf-access-jwt-assertion'));
  if (claims?.email) return { id: claims.email, kind: 'user' };
  if (claims?.common_name) {
    return { id: `svc:${claims.common_name.replace(/\.access$/, '')}`, kind: 'service' };
  }

  throw Object.assign(new Error('Access returned no identity'), { status: 401 });
}

/** Decode (not verify) the Access assertion payload. Returns null if unreadable. */
function readAssertion(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(payload + '='.repeat((4 - (payload.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- queries

const SELECT_WITH_TOUCH = `
  SELECT p.*, (SELECT MAX(occurred_at) FROM touches t WHERE t.prospect_id = p.id) AS last_touch_at
  FROM prospects p
`;

async function listProspects(db, q) {
  const where = [];
  const args = [];

  if (q.get('stage')) {
    const stages = q.get('stage').split(',').map((s) => s.trim()).filter(Boolean);
    where.push(`stage IN (${stages.map(() => '?').join(',')})`);
    args.push(...stages);
  }
  if (q.get('owner')) { where.push('lower(owner) = lower(?)'); args.push(q.get('owner')); }
  if (q.get('domain')) { where.push('lower(domain) = lower(?)'); args.push(q.get('domain')); }
  if (q.get('source')) { where.push('lower(source) = lower(?)'); args.push(q.get('source')); }

  if (q.get('q')) {
    where.push('(company LIKE ? OR contact_name LIKE ? OR contact_email LIKE ? OR domain LIKE ?)');
    const like = `%${q.get('q')}%`;
    args.push(like, like, like, like);
  }

  // --stale=7d : nothing logged in the last N days (never-touched counts as stale)
  const stale = q.get('stale');
  if (stale) {
    const days = parseInt(stale, 10);
    if (Number.isFinite(days)) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      where.push('(last_touch_at IS NULL OR last_touch_at < ?)');
      args.push(cutoff);
    }
  }

  if (q.get('due') === '1') {
    where.push('next_action_at IS NOT NULL AND next_action_at <= ?');
    args.push(now().slice(0, 10));
  }

  const limit = Math.min(parseInt(q.get('limit') || '200', 10) || 200, 1000);
  const offset = parseInt(q.get('offset') || '0', 10) || 0;

  const sql = `
    SELECT * FROM (${SELECT_WITH_TOUCH})
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (next_action_at IS NULL), next_action_at ASC, updated_at DESC
    LIMIT ? OFFSET ?`;

  const { results } = await db.prepare(sql).bind(...args, limit, offset).all();
  return results;
}

function fieldsFrom(body) {
  const out = {};
  for (const k of WRITABLE) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      out[k] = k === 'contact_email' ? (norm(body[k]) || '').toLowerCase() || null : norm(body[k]);
    }
  }
  return out;
}

async function createProspect(db, body, who, upsert) {
  const f = fieldsFrom(body);
  if (!f.company) return fail(400, 'company is required');
  if (f.stage && !STAGES.includes(f.stage)) {
    return fail(400, `unknown stage "${f.stage}"`, { stages: STAGES });
  }

  const ts = now();
  const row = {
    id: uid(),
    company: f.company,
    domain: f.domain ?? null,
    contact_name: f.contact_name ?? null,
    contact_email: f.contact_email ?? null,
    contact_title: f.contact_title ?? null,
    linkedin: f.linkedin ?? null,
    source: f.source ?? null,
    owner: f.owner ?? who.id,
    stage: f.stage ?? 'new',
    next_action: f.next_action ?? null,
    next_action_at: f.next_action_at ?? null,
    notes: f.notes ?? null,
    created_at: ts,
    updated_at: ts,
    updated_by: who.id,
  };

  const cols = Object.keys(row);

  // Upsert on email is the dedupe primitive: two agents racing the same lead
  // converge on one row instead of creating twins. Only the fields the caller
  // actually sent get merged — defaults we filled in for the INSERT (owner,
  // stage) must not silently overwrite what is already on the record.
  const merge = Object.keys(f).filter((c) => c !== 'contact_email');
  const conflict = upsert && row.contact_email
    ? ` ON CONFLICT(contact_email) DO UPDATE SET ${
        [...merge.map((c) => `${c} = excluded.${c}`),
         'updated_at = excluded.updated_at',
         'updated_by = excluded.updated_by',
         'rev = prospects.rev + 1'].join(', ')
      }`
    : '';

  const sql = `INSERT INTO prospects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})${conflict} RETURNING *`;

  try {
    const created = await db.prepare(sql).bind(...cols.map((c) => row[c])).first();
    return json(created, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return fail(409, `a prospect with email ${row.contact_email} already exists (use --upsert)`);
    }
    throw e;
  }
}

async function patchProspect(db, id, body, who, expectRev) {
  const f = fieldsFrom(body);
  if (f.stage && !STAGES.includes(f.stage)) {
    return fail(400, `unknown stage "${f.stage}"`, { stages: STAGES });
  }
  const keys = Object.keys(f);
  if (!keys.length) return fail(400, 'nothing to update');

  const sets = keys.map((k) => `${k} = ?`);
  const args = keys.map((k) => f[k]);
  sets.push('updated_at = ?', 'updated_by = ?', 'rev = rev + 1');
  args.push(now(), who.id);

  let sql = `UPDATE prospects SET ${sets.join(', ')} WHERE id = ?`;
  args.push(id);
  if (expectRev !== null) { sql += ' AND rev = ?'; args.push(expectRev); }
  sql += ' RETURNING *';

  const updated = await db.prepare(sql).bind(...args).first();
  if (updated) return json(updated);

  // Nothing changed: either the id is wrong, or someone else wrote first.
  const current = await db.prepare('SELECT * FROM prospects WHERE id = ?').bind(id).first();
  if (!current) return fail(404, `no prospect ${id}`);
  return fail(409, `prospect ${id} was modified by ${current.updated_by} (rev ${current.rev}, you expected ${expectRev})`, { current });
}

// ---------------------------------------------------------------- router

async function route(request, env, who) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const db = env.DB;
  const method = request.method;

  const body = ['POST', 'PATCH', 'PUT'].includes(method)
    ? await request.json().catch(() => ({}))
    : {};

  if (path === '/' || path === '/api/health') {
    return json({ ok: true, service: 'outbound', stages: STAGES, channels: CHANNELS });
  }

  if (path === '/api/whoami') return json({ id: who.id, kind: who.kind });


  // Raw SQL. Reads are open; writes need ?write=1; DDL is never allowed here —
  // schema is the developers' job, through migrations and review, not a CLI call.
  if (path === '/api/sql' && method === 'POST') {
    const sql = norm(body.sql);
    if (!sql) return fail(400, 'no sql given');

    const verdict = classifySql(sql);
    if (verdict.error) return fail(400, verdict.error);
    if (verdict.writes && url.searchParams.get('write') !== '1') {
      return fail(400, `"${verdict.verb}" modifies data — re-run with --write to confirm`);
    }

    try {
      const res = await db.prepare(sql).bind(...(Array.isArray(body.params) ? body.params : [])).all();
      return json({
        rows: res.results ?? [],
        count: (res.results ?? []).length,
        changes: res.meta?.changes ?? 0,
        wrote: verdict.writes,
      });
    } catch (e) {
      return fail(400, `sql error: ${e.message}`);
    }
  }

  // So an agent can read the shape of the database instead of guessing at it.
  if (path === '/api/schema') {
    const { results: tables } = await db.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'
       ORDER BY name`).all();

    const out = [];
    for (const t of tables) {
      const { results: cols } = await db.prepare(`PRAGMA table_info(${t.name})`).all();
      out.push({
        table: t.name,
        columns: cols.map((c) => ({
          name: c.name, type: c.type, notnull: !!c.notnull, pk: !!c.pk, default: c.dflt_value,
        })),
      });
    }
    return json({ tables: out, stages: STAGES, channels: CHANNELS });
  }

  if (path === '/api/stats') {
    const { results } = await db.prepare(
      'SELECT stage, COUNT(*) AS n FROM prospects GROUP BY stage ORDER BY n DESC').all();
    const total = results.reduce((a, r) => a + r.n, 0);
    return json({ total, by_stage: results });
  }

  if (path === '/api/prospects' && method === 'GET') {
    return json(await listProspects(db, url.searchParams));
  }

  if (path === '/api/prospects' && method === 'POST') {
    const upsert = url.searchParams.get('upsert') === '1';
    // Bulk: POST an array, get an array of results back.
    if (Array.isArray(body)) {
      const out = [];
      for (const item of body) {
        const res = await createProspect(db, item, who, upsert);
        out.push({ status: res.status, body: await res.json() });
      }
      return json(out, 207);
    }
    return createProspect(db, body, who, upsert);
  }

  const m = path.match(/^\/api\/prospects\/([A-Za-z0-9_-]+)(\/touches)?$/);
  if (m) {
    const [, id, isTouches] = m;

    if (isTouches) {
      if (method === 'GET') {
        const { results } = await db.prepare(
          'SELECT * FROM touches WHERE prospect_id = ? ORDER BY occurred_at DESC').bind(id).all();
        return json(results);
      }
      if (method === 'POST') {
        const channel = norm(body.channel) || 'other';
        if (!CHANNELS.includes(channel)) return fail(400, `unknown channel "${channel}"`, { channels: CHANNELS });
        const exists = await db.prepare('SELECT id FROM prospects WHERE id = ?').bind(id).first();
        if (!exists) return fail(404, `no prospect ${id}`);

        const ts = norm(body.occurred_at) || now();
        const touch = await db.prepare(
          `INSERT INTO touches (id, prospect_id, channel, direction, note, author, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        ).bind(uid(), id, channel, body.direction === 'in' ? 'in' : 'out',
               norm(body.note), who.id, ts).first();

        // A logged touch is activity; reflect it on the prospect too.
        await db.prepare('UPDATE prospects SET updated_at = ?, updated_by = ? WHERE id = ?')
          .bind(now(), who.id, id).run();
        return json(touch, 201);
      }
    }

    if (method === 'GET') {
      const row = await db.prepare(`SELECT * FROM (${SELECT_WITH_TOUCH}) WHERE id = ?`).bind(id).first();
      if (!row) return fail(404, `no prospect ${id}`);
      const { results } = await db.prepare(
        'SELECT * FROM touches WHERE prospect_id = ? ORDER BY occurred_at DESC LIMIT 50').bind(id).all();
      return json({ ...row, touches: results });
    }

    if (method === 'PATCH') {
      const raw = url.searchParams.get('expect_rev');
      return patchProspect(db, id, body, who, raw === null ? null : parseInt(raw, 10));
    }

    if (method === 'DELETE') {
      const res = await db.prepare('DELETE FROM prospects WHERE id = ?').bind(id).run();
      if (!res.meta.changes) return fail(404, `no prospect ${id}`);
      return json({ deleted: id });
    }
  }

  return fail(404, `no route for ${method} ${path}`);
}

export default {
  async fetch(request, env, ctx) {
    // Public bootstrap routes. Access is configured to bypass these paths; the
    // check here means a misconfigured bypass cannot expose anything but these two.
    const { pathname, origin } = new URL(request.url);

    if (pathname === '/install') {
      return new Response(INSTALL_SH.replace(/__ORIGIN__/g, origin), {
        headers: { 'content-type': 'text/x-shellscript; charset=utf-8' },
      });
    }
    if (pathname === '/cli') {
      return new Response(CLI_SOURCE, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'content-disposition': 'attachment; filename="outbound"',
        },
      });
    }

    let who;
    try {
      who = await identify(request, ctx);
    } catch (e) {
      return fail(e.status || 401, e.message);
    }
    try {
      return await route(request, env, who);
    } catch (e) {
      return fail(500, e.message || 'internal error');
    }
  },
};
