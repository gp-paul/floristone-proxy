
export const config = { runtime: "edge" };

const ALLOWED_UPSTREAMS: Record<string, string> = {
  flowershop: process.env.F1_FLOWERSHOP_BASE || "https://www.floristone.com/api/flowershop",
  tree:       process.env.F1_TREE_BASE       || "https://www.floristone.com/api/tree",
  cart:       process.env.F1_CART_BASE       || "https://www.floristone.com/api/cart",
};

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,https://www.figma.com")
  .split(",").map(s => s.trim());

function corsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Credentials": "false",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Api,Accept",
    "Vary": "Origin",
  };
}

function b64(user: string, pass: string) {
  try { return btoa(`${user}:${pass}`); } catch { return Buffer.from(`${user}:${pass}`).toString("base64"); }
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const headersBase = corsHeaders(origin);

  // Handle preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headersBase });
  }

  // Choose upstream
  const api = (url.searchParams.get("api") || "flowershop").toLowerCase();
  const upstreamBase = ALLOWED_UPSTREAMS[api];
  if (!upstreamBase) {
    return new Response(JSON.stringify({ error: "Invalid API selector" }), {
      status: 400, headers: { ...headersBase, "Content-Type": "application/json" }
    });
  }

  // Path after /api/floristone/
  const pathAfter = url.pathname.replace(/^\/api\/floristone\/?/, "");
  const target = new URL(pathAfter || "", upstreamBase);

  // Forward query params except 'api'
  url.searchParams.forEach((v, k) => { if (k !== "api") target.searchParams.set(k, v); });

  // Load credentials
  const key = process.env.F1_API_KEY!;
  const pass = process.env.F1_API_PASSWORD!;
  if (!key || !pass) {
    return new Response(JSON.stringify({ error: "Server missing F1 credentials" }), {
      status: 500, headers: { ...headersBase, "Content-Type": "application/json" }
    });
  }

  // Build outbound headers
  const outboundHeaders = new Headers();
  outboundHeaders.set("Authorization", `Basic ${b64(key, pass)}`);
  outboundHeaders.set("Accept", req.headers.get("accept") || "application/json");
  const contentType = req.headers.get("content-type");
  if (contentType) outboundHeaders.set("Content-Type", contentType);

  // Build fetch init
  const init: RequestInit = {
    method: req.method,
    headers: outboundHeaders,
    body: (req.method === "GET" || req.method === "HEAD") ? undefined : await req.blob(),
    redirect: "manual",
  };

  try {
    const upstreamRes = await fetch(target.toString(), init);

    // OPTIONAL HARDENING: allowlist certain path prefixes
    // const allowedPrefixes = ["categories", "occasions", "products", "cart", "order", "trees", "packages", "deliverydates"];
    // const ok = allowedPrefixes.some(p => (pathAfter || "").startsWith(p));
    // if (!ok) return new Response(JSON.stringify({ error: "Path not allowed" }), { status: 403, headers: { ...headersBase, "Content-Type": "application/json" } });

    const resHeaders = new Headers(headersBase);
    const upstreamCT = upstreamRes.headers.get("content-type");
    if (upstreamCT) resHeaders.set("Content-Type", upstreamCT);
    resHeaders.set("Cache-Control", "no-store");

    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: resHeaders });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "Upstream fetch failed", detail: String(err?.message || err) }), {
      status: 502, headers: { ...headersBase, "Content-Type": "application/json" }
    });
  }
}
