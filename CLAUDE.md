# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file reverse proxy that runs as a Cloudflare Worker. It serves multiple proxied sites from one Worker, with on-the-fly response rewriting (string replacement, per-path resource substitution, redirects) and Cloudflare email-obfuscation bypass.

There is **no build system, package manager, test suite, or deploy script**. Deployment is manual: copy `worker.js` into a Cloudflare Worker via the dashboard, then edit the `reverse` config object at the top of the same file. `reverse_demo.js` is a documented reference for that config — it is not imported or executed.

## Architecture

Everything lives in `worker.js`, driven by the global `reverse` config object (keyed by the public domain the Worker is served on).

Request flow in the `fetch` event listener:
1. **Domain match** — iterate `reverse` and pick the first key where the incoming `url.host` *ends with* the key (suffix match, so subdomains match). The matched config becomes the module-global `target`; its key is stored as `target.f_host`. No match → 404.
2. **Rewrite the outbound URL** — set `url.protocol`, `url.host`, and (optionally) `url.port` from the target.
3. **`redirect`** — if `url.pathname` is a key in `target.redirect`, return a 302 immediately (no upstream fetch).
4. **`reverse` (path override)** — if `url.pathname` is a key in `target.reverse`, replace it: a value starting with `http` swaps the entire URL (cross-origin resource), otherwise it replaces just the pathname.
5. **`path_prefix`** — optional prefix prepended to the pathname.
6. Forward via `handleRequest`.

`handleRequest` fetches upstream and, **only for json/html/text/javascript content types**, rewrites the body:
- Decodes Cloudflare `data-cfemail` / `email-protection#` tokens (`cfDecodeEmail`), applies the same replacements to the cleartext, re-encodes (`cfEncodeEmail`), and adds those to `target.replace` so the obfuscated emails get swapped too.
- Applies every `target.replace` string pair via `replaceAll`.
- Replaces all occurrences of `target.host` with `target.f_host` so upstream's own hostname becomes the proxy domain.

### Config fields (per domain entry)
- `protocol`, `host` — required upstream protocol and hostname.
- `port` — optional upstream port; omit for the protocol default (80/443).
- `replace` — `{ find: replace }` string pairs applied to text responses.
- `reverse` — `{ pathname: newPathnameOrFullUrl }` path overrides (see step 4).
- `redirect` — `{ pathname: location }` 302 redirects.
- `path_prefix` — optional, read at runtime but not present in the demo config.

The `replace`, `reverse`, and `redirect` objects are all looked up with `in` / `Object.entries`, so each entry must include them (use `{}` when empty) or the Worker throws at request time.

## Gotchas

- `target` and `replace_add` are module-global mutable state reused across requests — be careful introducing race-sensitive logic; the proxy mutates `target.replace`, `target.html`, and `target.f_host` per request.
- Host replacement in response bodies swaps the **hostname only, not the port**. If an upstream emits absolute URLs containing `host:port`, the port is left dangling (`proxydomain:port`); add an explicit `replace` entry to fix.
- The `port` config field controls only the **upstream** connection. Inbound traffic to the Worker is still served on Cloudflare's standard ports.
