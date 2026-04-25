# 13ft companion — server-side bypass for FCrDNS-stuck sites

The 13ft browser extension handles ~80% of paywalled sites
client-side. The remaining ~20% — Financial Times, Bloomberg
premium, WSJ premium, Le Monde — verify that incoming Googlebot
requests actually originate from Google's IP ranges
([FCrDNS](../docs/limitations.md#fcrdns-verified-googlebot)).
A browser extension running from your home IP can't beat that.

This companion is the answer: a tiny Docker template that runs
[Ladder](https://github.com/everywall/ladder) (a paywall-bypass
reverse proxy) and optionally [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)
(a Cloudflare CAPTCHA solver). Point 13ft's `custom (Ladder)…`
proxy field at it, and the extension routes FCrDNS-stuck sites
through your own datacenter IP instead of giving up.

You're running it. You own the IP. No central service for
publishers to DMCA. That's the whole point.

## Quick start (localhost)

```bash
cd companion
docker compose up -d
```

Verify it's up:

```bash
curl -I http://localhost:8080/https://example.com
# → HTTP/1.1 200 OK
```

Configure 13ft:

1. Open the extension popup on any page.
2. **Strategy** → `proxy`
3. **Content proxy** → `custom (Ladder)…`
4. **URL** → `http://localhost:8080/`

That's it. Reload an FCrDNS-stuck article (e.g.
[ft.com](https://ft.com)) — 13ft will fetch it through your local
Ladder, which forwards from a Docker-NAT'd address with a Googlebot
UA that the publisher actually serves.

## Quick start (cloud, $0–$2/month)

Localhost works for **you**. If you want it to work from your phone,
laptop on the train, or other devices — host it.

[Fly.io](https://fly.io) is the cheapest path. The included
[`fly.toml`](./fly.toml) deploys Ladder on a free shared-cpu machine
that scales to zero when idle:

```bash
brew install flyctl  # or: curl -L https://fly.io/install.sh | sh
flyctl auth login

cd companion
# pick a globally-unique app name and edit fly.toml's `app = "..."`
flyctl launch --copy-config --no-deploy
flyctl secrets set USERNAME=ladder PASSWORD=$(openssl rand -hex 16)
flyctl deploy
```

Then in 13ft:

```
URL → https://<your-app>.fly.dev/
```

Save the password 13ft prompts for it on the first request.

> **Note:** Fly's free tier doesn't fit FlareSolverr (Chromium needs
> ~512MB+ RAM). The Fly template ships Ladder only. In practice
> ~70% of FCrDNS-stuck sites work from a clean Fly IP without
> FlareSolverr — the IP is the lock, not the CAPTCHA. If you need
> Cloudflare CAPTCHA solving on a specific site, fall back to the
> Docker Compose stack locally.

## When to use the companion (decision tree)

```
Is the site FCrDNS-verified?  (FT, Bloomberg, WSJ, Le Monde)
  └─ Yes → Companion.
  └─ No, but Cloudflare keeps challenging me?
       └─ Yes → Companion (Docker Compose, FlareSolverr does the work).
       └─ No → Probably don't need the companion. The extension
                alone covers ~80% of curated publishers.

Do I have a paid subscription I want to share with my family on
devices that aren't logged in?
  └─ Yes → Companion. Ladder lets you inject your session cookies.
            See "Sharing your subscription" below.
```

If you're unsure, **start without the companion**. The extension
alone handles Atlantic, Boston Globe, Wired, Reuters, the entire
Condé Nast portfolio, most regional newspapers. The companion is
specifically for the long tail.

## What's in this directory

- [`docker-compose.yml`](./docker-compose.yml) — Ladder +
  FlareSolverr, bound to localhost only by default.
- [`fly.toml`](./fly.toml) — Fly.io single-machine deploy template
  (Ladder only).
- [`ladder-config/ruleset.yaml`](./ladder-config/ruleset.yaml) —
  starter rules for the FCrDNS-class publishers (FT, Bloomberg,
  WSJ, Le Monde) with Googlebot UA, Google referer, and FlareSolverr
  passthrough.

## Hardening

The defaults in `docker-compose.yml` bind Ladder to `127.0.0.1`
only. **Don't change that** without setting auth, or your machine
becomes a public open proxy and you'll receive abuse complaints
from your hosting provider within days.

If you expose to anything beyond localhost (Tailscale, Fly,
Cloudflare Tunnel, anything), at minimum:

1. **Set Basic Auth.** Uncomment `USERNAME` / `PASSWORD` in the
   compose file (or `flyctl secrets set` for Fly).
2. **Bind to a private interface or Tailscale tailnet IP** — not
   `0.0.0.0`. Localhost or tailnet only; let the publisher's edge
   see your IP, not random scrapers.
3. **Set up rate limiting.** Ladder doesn't ship with built-in
   rate limiting; put a Caddy or nginx in front if you're exposing
   it. A single misconfigured client can rack up bandwidth fast.

The threat model isn't subtle: an unauthenticated Ladder is an
open relay, and the legal exposure is **yours**, not the
extension's. The publisher will go after the IP that hit them,
which is your IP.

For the full hardening checklist see
[`docs/hardening.md`](../docs/hardening.md).

## Sharing your subscription (advanced)

If you have a paid FT/Bloomberg/WSJ subscription and want to
read on a device that isn't logged in (the "share my subscription
with my family" use case), Ladder can pass your session cookies
forward.

Edit [`ladder-config/ruleset.yaml`](./ladder-config/ruleset.yaml)
and add a `cookies:` block to the relevant rule. Pull the values
out of your browser's DevTools → Application → Cookies after
logging in:

```yaml
- domain: ft.com
  domains: [ft.com, www.ft.com]
  useFlareSolverr: true
  cookies:
    FTSession: "abc123..."        # from devtools, your real session
    FTSession_s: "def456..."
  headers:
    user-agent: "Mozilla/5.0..."
    referer: "https://www.google.com/"
```

This is **legal use of a subscription you paid for**, not piracy.
But it's also why the companion stays opt-in and self-hosted: a
public proxy with someone else's session cookies is a felony, and
we're not building that.

## How this differs from public 12ft.io / smry.ai / archive.ph

| | 13ft companion | 12ft.io / smry.ai | archive.ph |
|---|---|---|---|
| Where does it run? | Your machine / your Fly account | A public service someone else operates | A public archive |
| Who's the IP they hit? | You | The service operator | archive.ph |
| Cost | $0–$2/mo | Free until DMCA'd | Free, donor-funded |
| Site coverage | Whatever you write rules for | Whatever the operator covers | Whatever's been archived |
| Up tomorrow? | Yes (you control it) | Maybe (DMCA risk) | Yes |
| Legal exposure | Yours | Theirs | Internet Archive's |

12ft.io got DMCA'd. smry.ai will probably get DMCA'd. archive.ph
is a different beast (permissioned crawl deal with some publishers,
Internet Archive's legal armor). The companion gives you the 12ft
experience without the takedown risk because **you're the operator**.

## Troubleshooting

**`docker compose up` says "image not found"**: GitHub Container
Registry sometimes throttles unauthenticated pulls. Wait 5
minutes, or `docker login ghcr.io` with a GitHub PAT (read:packages).

**Ladder returns 503 on FCrDNS sites**: FlareSolverr probably
crashed. `docker compose logs flaresolverr`. Common cause: not
enough RAM. FlareSolverr wants 512MB minimum on top of the host
OS.

**Ladder returns 200 but the body is the publisher's paywall HTML**:
The site updated its FCrDNS check, or your Fly IP is on a list
the publisher recognizes. Try a different Fly region (`flyctl
regions add lhr` for London, etc.) or fall back to local Docker
where your home connection's NAT'd IP is fresher.

**Fly says my app crashed on boot**: most likely OOM. Bump memory:
`flyctl scale memory 512`. Or remove FlareSolverr from your stack.

**13ft keeps showing FAIL even with the companion configured**:
Check the dashboard (popup → ⓘ → "Open dashboard"). The strategy
chain logs whether the proxy step ran and what it returned. If
the proxy is returning 200 but with empty bodies, that's a Ladder
ruleset issue — open Ladder's UI directly at `http://localhost:8080/`
and try the URL there to debug.

## Contributing rules

Ladder's community rule pack is at
[everywall/ladder-rules](https://github.com/everywall/ladder-rules).
If you write a rule that fixes a publisher 13ft and Ladder both
struggle with, please send it upstream — both projects benefit.

For 13ft-specific changes (extension behavior, the failure
detector, popup UX), open an issue on the main repo.

## License

The companion files in this directory are MIT-licensed, same as
13ft. Ladder itself is GPL-3.0; FlareSolverr is MIT. Both are
pulled from upstream container images at runtime; nothing is
vendored here.
