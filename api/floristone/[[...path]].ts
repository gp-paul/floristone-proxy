export const config = { runtime: "edge" };

/**
 * Florist One proxy (Vercel Edge)
 * - Injects Basic Auth from env vars (never expose creds to the client)
 * - Handles CORS with an origin allowlist
 * - Follows upstream redirects (301/302/303/307/308)
 * - Uses real REST bases:
 *     https://www.floristone.com/api/rest/flowershop/
 *     https://www.floristone.com/api/rest/cart/
 *     https://www.floristone.com/api/rest/tree/
 *   (You can override via F1_FLOWERSHOP_BASE / F1_CART_BASE / F1_TREE_BASE)
 */

const withSlash = (s: string) => (s.endsWith("/") ? s : s + "/");

// Canonical REST bases
const DEFAULT_FLOWERSHOP_BASE = "https://www.floristone.com/api/rest/flowershop/";
const DEFAULT_CART_BASE       = "https://www.floristone.com/api/rest/cart/";
const DEFAULT_TREE_BASE       = "https://www.floristone.com/api/rest/tree/";

// If you prefer zero TS config, keep these ts-expect-error lines so Vercel builds pass.
// Otherwise, add @types/node and include it in tsconfig "types".
/* @ts-expect-error process is injected in Vercel Edge at runtime */
const FLOWERSHOP_BASE = withSlash(process.env.F1_FLOWERSHOP_BASE || DEFAULT_FLOWERSHOP_BASE);
/* @ts-expect-error process is injected in Vercel Edge at runtime */
const CART_BASE       = withSlash(process.env.F1_CART_BASE       || DEFAULT_CART_BASE);
/* @ts-expect-error process is injected in Vercel Edge at runtime */
const TREE_BASE       = withSlash(process.env.F1_TREE_BASE       || DEFAULT_TREE_BASE);

/* @ts-expect-error process is injected in Vercel Edge at runtime */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,https://www.figma.com")
  .split(",").map(s => s.trim());

const ALLOWED_UPSTREAMS: Record<string, string> = {
  flowershop: FLOWERSHOP_BASE,
  cart:       CART_BASE,
  tree:       TREE_BASE,
};

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
  // @ts-expect-error Buffer not typed in Edge; guarded for local/dev
  catch { return (globalThis as any).Buffer?.from(`${user}:${pass}`).toString("base64"); }
}

// Follow redirects up to maxHops, preserving RFC semantics for method/body
async function fetchFollow(url: string, init: RequestInit, maxHops = 5): Promise<Response> {
  let currentUrl = url;
  let currentInit: RequestInit = { ...init, redirect: "manual" };
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(currentUrl, currentInit);
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;

    const loc = res.headers.get("location");
    if (!loc) return res;

    const nextUrl = new URL(loc, currentUrl).toString();
    const method = (currentInit.method || "GET").toUpperCase();

    // Switch to GET (drop body) for 303, and for 301/302 when original wasn't GET/HEAD
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
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

  // Choose upstream by ?api=flowershop|cart|tree (default flowershop)
  const api = (url.searchParams.get("api") || "flowershop").toLowerCase();
  const upstreamBase = ALLOWED_UPSTREAMS[api];
  if (!upstreamBase) {
    return new Response(JSON.stringify({ error: "Invalid API selector" }), {
      status: 400,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
    });
  }

  // Map everything after /api/floristone/ directly onto the chosen base.
  // e.g. /api/floristone/getproducts?api=flowershop -> .../api/rest/flowershop/getproducts
  const pathAfter = url.pathname.replace(/^\/api\/floristone\/?/, "");
  const target = new URL(pathAfter || "", upstreamBase);

  // Forward query params except 'api'
  url.searchParams.forEach((v, k) => { if (k !== "api") target.searchParams.set(k, v); });

  // Credentials
  /* @ts-expect-error process is injected in Vercel Edge at runtime */
  const key = process.env.F1_API_KEY;
  /* @ts-expect-error process is injected in Vercel Edge at runtime */
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
    redirect: "manual", // we implement manual following to cap hops & preserve semantics
  };

  try {
    // OPTIONAL HARDENING: allow-list known prefixes (uncomment to lock down)
    // const allowed = ["getproducts","getcategories","getoccasions","getdeliverydates",
    //                  "createcart","additem","setrecipient","setbilling","checkout","getorder"];
    // if (pathAfter && !allowed.some(p => pathAfter.startsWith(p))) {
    //   return new Response(JSON.stringify({ error: "Path not allowed" }), {
    //     status: 403, headers: { ...baseHeaders, "Content-Type": "application/json" },
    //   });
    // }

    const upstreamRes = await fetchFollow(target.toString(), init);

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
