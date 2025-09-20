export const config = { runtime: "edge" };

/**
 * Florist One proxy (Vercel Edge)
 * - Injects Basic Auth from env vars
 * - Handles CORS with an origin allowlist
 * - Follows upstream redirects (301/302/303/307/308)
 * - Defaults all bases to https://www.floristone.com/floristone/
 *   (override via F1_FLOWERSHOP_BASE / F1_TREE_BASE / F1_CART_BASE)
 */

const DEFAULT_BASE = "https://www.floristone.com/floristone/";
const withSlash = (s: string) => (s.endsWith("/") ? s : s + "/");

const ALLOWED_UPSTREAMS: Record<string, string> = {
  flowershop: withSlash(process.env.F1_FLOWERSHOP_BASE || DEFAULT_BASE),
  tree:       withSlash(process.env.F1_TREE_BASE       || DEFAULT_BASE),
  cart:       withSlash(process.env.F1_CART_BASE       || DEFAULT_BASE),
};

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,https://www.figma.com")
  .split(",")
  .map(s => s.trim());

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
  try { return btoa(`${user}:${pass}`); }
  catch { return (globalThis as any).Buffer?.from(`${user}:${pass}`).toString("base64"); }
}

// Follow redirects up to maxHops, preserving RFC semantics
async function fetchFollow(url: string, init: RequestInit, maxHops = 5): Promise<Response> {
  let currentUrl = url;
  let currentInit: RequestInit = { ...init, redirect: "manual" };
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(currentUrl, currentInit);
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;

    const loc = res.headers.get("location");
    if (!loc) return res;

    const nextUrl = new URL(loc, currentUrl).toString();

    // Switch to GET and drop body for 303 (always) and for 301/302 on non-GET (common client behavior)
    const method = (currentInit.method || "GET").toUpperCase();
    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")
    ) {
      currentInit = { ...currentInit, method: "GET", body: undefined };
    }

    currentUrl = nextUrl;
  }
  throw new Error("Too many redirects");
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const baseHeaders = corsHeaders(origin);

  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  // Choose upstream by ?api=flowershop|tree|cart (default flowershop)
  const api = (url.searchParams.get("api") || "flowershop").toLowerCase();
  const upstreamBase = ALLOWED_UPSTREAMS[api];
  if (!upstreamBase) {
    return new Response(JSON.stringify({ error: "Invalid API selector" }), {
      status: 400,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
    });
  }

  // Path after /api/floristone/
  const pathAfter = url.pathname.replace(/^\/api\/floristone\/?/, "");
  const target = new URL(pathAfter || "", upstreamBase);

  // Forward query params except 'api'
  url.searchParams.forEach((v, k) => {
    if (k !== "api") target.searchParams.set(k, v);
  });

  // Credentials
  const key = process.env.F1_API_KEY;
  const pass = process.env.F1_API_PASSWORD;
  if (!key || !pass) {
    return new Response(JSON.stringify({ error: "Server missing F1 credentials" }), {
      status: 500,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
    });
  }

  // Outbound headers (never forward client Authorization)
  const outHeaders = new Headers();
  outHeaders.set("Authorization", `Basic ${b64(key, pass)}`);
  outHeaders.set("Accept", req.headers.get("accept") || "application/json");
  const contentType = req.headers.get("content-type");
  if (contentType) outHeaders.set("Content-Type", contentType);

  // Build request init
  const init: RequestInit = {
    method: req.method,
    headers: outHeaders,
    body: (req.method === "GET" || req.method === "HEAD") ? undefined : await req.blob(),
    redirect: "manual", // we follow manually to cap hops and preserve semantics
  };

  try {
    // OPTIONAL HARDENING: allow-list certain path prefixes
    // const allowed = ["categories", "occasions", "products", "cart", "order", "deliverydates", "packages", "trees"];
    // if (pathAfter && !allowed.some(p => pathAfter.startsWith(p))) {
    //   return new Response(JSON.stringify({ error: "Path not allowed" }), {
    //     status: 403, headers: { ...baseHeaders, "Content-Type": "application/json" },
    //   });
    // }

    const upstreamRes = await fetchFollow(target.toString(), init);

    // Build response
    const resHeaders = new Headers(baseHeaders);
    const upstreamCT = upstreamRes.headers.get("content-type");
    if (upstreamCT) resHeaders.set("Content-Type", upstreamCT);
    resHeaders.set("Cache-Control", "no-store");

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: "Upstream fetch failed", detail: String(err?.message || err) }),
      { status: 502, headers: { ...baseHeaders, "Content-Type": "application/json" } }
    );
  }
}
