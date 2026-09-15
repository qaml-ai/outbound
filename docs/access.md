# Putting Cloudflare Access in front of the Worker

The Worker has no auth of its own. It refuses every request where `ctx.access` is
missing, so it fails closed if Access is ever removed — but it is only actually
protected once Access is configured.

## What the Worker sees

Access authenticates the request before the Worker runs and exposes the result on
`ctx.access`. There is no JWT to verify and no JWKS to cache:

```js
const identity = await ctx.access.getIdentity();
identity?.email        // human logins
ctx.access.aud         // the Access application
```

Service tokens are the exception: for them `getIdentity()` returns `undefined` and
`ctx.access` carries only `aud`. Their name lives on the `cf-access-jwt-assertion`
header as `common_name`, which `src/index.js` decodes without verifying — `ctx.access`
already proves Access authenticated the request, and Access strips any client-supplied
copy of its own headers, so this is labelling an actor that is already trusted rather
than deciding whether to trust it.

## Enabling it

Dashboard: **Workers & Pages → your Worker → Settings → Access → Protect this Worker
behind Access**. That covers the `workers.dev` hostname, custom domains, routes, and
preview URLs in one go, and the policy follows the Worker if its routes change.

Or create a self-hosted Access application over the API pointed at the Worker hostname:

```bash
ACC=<account-id>
curl -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps" \
  --data '{
    "name": "outbound",
    "type": "self_hosted",
    "domain": "outbound.<subdomain>.workers.dev",
    "session_duration": "24h",
    "allowed_idps": ["<google-idp-id>"],
    "auto_redirect_to_identity": true
  }'
```

## Policies

Two, because humans and agents authenticate differently.

**Humans** — allow an email domain, resolved through the Google Workspace IdP:

```json
{ "name": "team", "decision": "allow",
  "include": [{ "email_domain": { "domain": "example.com" } }] }
```

**Agents** — service tokens are `non_identity`, and scoping to a specific token id is
better than `any_valid_service_token`, which would admit every service token in the
account:

```json
{ "name": "outbound agents", "decision": "non_identity",
  "include": [{ "service_token": { "token_id": "<id>" } }] }
```

Create the token under **Zero Trust → Access → Service Tokens**. The client secret is
shown once. Put it in `~/.config/outbound/config.json` (mode 600) or
`OUTBOUND_CLIENT_SECRET` — never in this repo.

## The public bootstrap paths

`curl <worker>/install | sh` has to work on a machine that has no credentials yet, so
`/install` and `/cli` need to be reachable without signing in. Both serve only the CLI,
which is already public on GitHub — no secrets, no data.

Create a second Access application scoped to each path, with a bypass policy. A
path-scoped application takes precedence over the app covering the whole hostname, so
everything else stays protected:

```bash
ACC=<account-id>
APP=$(curl -s -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps" \
  --data '{"name":"outbound install (public)","type":"self_hosted",
           "domain":"outbound.<subdomain>.workers.dev/install",
           "app_launcher_visible":false}' | jq -r .result.id)

curl -s -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps/$APP/policies" \
  --data '{"name":"public","decision":"bypass","include":[{"everyone":{}}]}'
```

Repeat for `/cli`. In the dashboard the same thing is **Zero Trust → Access →
Applications → Add → Self-hosted**, path `…/install`, with a single **Bypass /
Everyone** policy.

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://outbound.<subdomain>.workers.dev/install   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://outbound.<subdomain>.workers.dev/api/health # 302
```

If you would rather not loosen Access at all, skip the bypass and have people install
from GitHub instead — the Worker's `/install` is a convenience, not a requirement.

## Human login from the CLI

`outbound login` shells out to `cloudflared`, which opens a browser for the Google flow
and caches a token:

```bash
brew install cloudflared
outbound login
```

Subsequent commands call `cloudflared access token -app=<api>` and send the result as
`cf-access-token`.

## Checking it works

```bash
curl -s https://outbound.<subdomain>.workers.dev/api/health    # 302 to the login page
outbound whoami                                                 # your identity
```

An anonymous request getting JSON back instead of a redirect means Access is not
actually in front of the Worker.
