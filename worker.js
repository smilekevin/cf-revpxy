
reverse = {}

target = {} //Temporary variable, do not edit

addEventListener("fetch", event => {
    var request = event.request
    var url = new URL(event.request.url);

    // Domain match (skip "*" — handled as fallback below)
    for (const [s_domain, s_target] of Object.entries(reverse)) {
        if (s_domain === "*") continue;
        if (url.host.endsWith(s_domain)) {
            target = reverse[s_domain];
            target.f_host = s_domain;
            break;
        }
    }

    // Fallback: "*" matches any domain that wasn't matched above
    if (target.f_host == undefined && reverse["*"]) {
        target = reverse["*"];
        target.f_host = "*";
    }

    if (target.f_host == undefined) {
        return event.respondWith(new Response("Not found", { status: 404 }));
    }

    url.protocol = target.protocol;
    url.host = target.host;
    if (target.port) url.port = target.port;

    if (url.pathname in target.redirect) {
        return event.respondWith(new Response("", {
            status: 302,
            headers: { "Location": target.redirect[url.pathname] }
        }));
    }

    if (url.pathname in target.reverse) {
        var rev = target.reverse[url.pathname];
        url = rev.startsWith("http") ? new URL(rev) : (url.pathname = rev, url);
    }

    if (target.path_prefix) {
        url.pathname = target.path_prefix + url.pathname;
    }

    // ---- WebSocket upgrade: relay to upstream ----
    const upgrade = request.headers.get("Upgrade");
    if (upgrade && upgrade.toLowerCase() === "websocket") {
        event.passThroughOnException();
        return event.respondWith(handleWebSocket(url, request));
    }

    const modifiedRequest = new Request(url, {
        body: request.body,
        headers: request.headers,
        method: request.method
    });
    event.passThroughOnException();
    return event.respondWith(handleRequest(modifiedRequest, target));
});

// ---- WebSocket bidirectional relay ----
async function handleWebSocket(upstreamUrl, clientRequest) {
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);
    serverWs.accept();

    // Build clean upstream headers (strip CF hop-by-hop)
    const upstreamHeaders = new Headers();
    const skip = new Set(["host", "cf-connecting-ip", "x-forwarded-for",
        "x-forwarded-proto", "cf-ray", "cf-visitor", "cdn-loop"]);
    for (const [k, v] of clientRequest.headers) {
        if (!skip.has(k.toLowerCase())) upstreamHeaders.set(k, v);
    }
    upstreamHeaders.set("Host", upstreamUrl.host);
    upstreamHeaders.set("X-Forwarded-For",
        clientRequest.headers.get("CF-Connecting-IP") || "");

    try {
        const upstreamResp = await fetch(upstreamUrl.href, { headers: upstreamHeaders });
        const upstreamWs = upstreamResp.webSocket;
        if (!upstreamWs) {
            serverWs.close(1011, "Upstream refused WebSocket upgrade");
            return new Response(null, { status: 101, webSocket: clientWs });
        }
        upstreamWs.accept();

        // Bidirectional relay with guard against double-close
        let closed = false;
        const close = () => {
            if (closed) return; closed = true;
            try { serverWs.close(); } catch (_) {}
            try { upstreamWs.close(); } catch (_) {}
        };
        serverWs.addEventListener("message", ev => {
            try { if (!closed) upstreamWs.send(ev.data); } catch (_) { close(); }
        });
        upstreamWs.addEventListener("message", ev => {
            try { if (!closed) serverWs.send(ev.data); } catch (_) { close(); }
        });
        serverWs.addEventListener("close", close);
        upstreamWs.addEventListener("close", close);
        serverWs.addEventListener("error", close);
        upstreamWs.addEventListener("error", close);

        return new Response(null, { status: 101, webSocket: clientWs });
    } catch (_) {
        serverWs.close(1011, "Upstream connection failed");
        return new Response(null, { status: 101, webSocket: clientWs });
    }
}

// ---- Email obfuscation helpers ----
function cfDecodeEmail(s) {
    var r = parseInt(s.substr(0, 2), 16), out = "", n;
    for (n = 2; n < s.length; n += 2)
        out += String.fromCharCode(parseInt(s.substr(n, 2), 16) ^ r);
    return out;
}

function cfEncodeEmail(email, key) {
    key = key || Math.floor(Math.random() * 89) + 11;
    var out = key.toString(16).padStart(2, "0");
    for (const c of email)
        out += (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0");
    return out;
}

// ---- HTTP request handler ----
async function handleRequest(req, tgt) {
    var response = await fetch(req);

    // API backends: passthrough, no body rewriting
    if (tgt.no_rewrite) return response;

    var contype = response.headers.get("Content-Type");
    if (!contype || !(contype.includes("json") || contype.includes("html") ||
        contype.includes("text") || contype.includes("javascript"))) {
        return response;
    }

    var html = await response.text();

    // Build a local replace map (never mutate the global config)
    var replace = Object.assign({}, tgt.replace);

    // Decode CF email obfuscation, apply user replacements, re-encode
    var emails = [...html.matchAll(/data-cfemail="([a-z0-9]+)"/g)]
        .concat([...html.matchAll(/email-protection#([a-z0-9]+)"/g)]);
    for (const [, enc] of emails) {
        var decoded = cfDecodeEmail(enc);
        for (const [rs, rd] of Object.entries(replace))
            decoded = decoded.replaceAll(rs, rd);
        decoded = decoded.replaceAll(tgt.host, tgt.f_host);
        replace[enc] = cfEncodeEmail(decoded);
    }

    // Apply all replacements + host rewrite
    for (const [rs, rd] of Object.entries(replace))
        html = html.replaceAll(rs, rd);
    html = html.replaceAll(tgt.host, tgt.f_host);

    return new Response(html, { headers: response.headers });
}
