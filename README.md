
# Florist One CORS Proxy (Vercel Edge)

A tiny, secure proxy to call the **Florist One** APIs from the browser (or Figma Make) despite CORS restrictions.
It injects **HTTP Basic Auth** on the server side and returns CORS-enabled responses to your frontend.

## What you get
- **Edge Function** at `/api/floristone/*` (fast, no server to manage)
- Clean URL rewrite: `/floristone/*` → `/api/floristone/*`
- Origin allowlist for CORS
- Safe Basic-Auth injection via environment variables
- Minimal demo page (`/public/index.html`) to test `categories`

---

## 1) Deploy to Vercel

**Option A: Import this repo** into Vercel directly (recommended).
**Option B: Local CLI**

```bash
npm i -g vercel
vercel link        # link folder to a Vercel project
vercel env add F1_API_KEY
vercel env add F1_API_PASSWORD
vercel env add ALLOWED_ORIGINS
# (optional)
vercel env add F1_FLOWERSHOP_BASE
vercel env add F1_TREE_BASE
vercel env add F1_CART_BASE

vercel deploy
```

> During prototyping you can set `ALLOWED_ORIGINS` to:  
> `http://localhost:3000,https://www.figma.com`  
> Later, lock it down to your domains only.

**Required env vars**
- `F1_API_KEY` – your Florist One API key (e.g., `984906`)
- `F1_API_PASSWORD` – your Florist One API password (e.g., `60dJ8E`)
- `ALLOWED_ORIGINS` – comma-separated origins allowed by CORS

**Optional env vars**
- `F1_FLOWERSHOP_BASE` (default `https://www.floristone.com/api/flowershop`)
- `F1_TREE_BASE`       (default `https://www.floristone.com/api/tree`)
- `F1_CART_BASE`       (default `https://www.floristone.com/api/cart`)

---

## 2) Endpoints

Proxy base:
```
https://<your-app>.vercel.app/api/floristone
# or with rewrite:
https://<your-app>.vercel.app/floristone
```

Select upstream via `?api=`: `flowershop` (default) | `tree` | `cart`

Examples:
```
GET  /floristone/categories?api=flowershop
GET  /floristone/products/ROSE-123?api=flowershop
POST /floristone/cart?api=cart
POST /floristone/cart/items?api=cart
GET  /floristone/order/12345?api=cart
GET  /floristone/packages?api=tree
```

---

## 3) Frontend usage

Just call the proxy from your browser app. **Do not** send Authorization headers—
the proxy injects them.

```js
const PROXY = "https://<your-app>.vercel.app/floristone"; // thanks to vercel.json rewrite

const cats = await fetch(`${PROXY}/categories?api=flowershop`, {
  headers: { "Accept": "application/json" }
}).then(r => r.json());
console.log(cats);
```

---

## 4) Security hardening

- **Origin allowlist:** keep `ALLOWED_ORIGINS` tight.
- **Path allowlist:** see the comment in the handler to restrict allowed path prefixes.
- **No credentials to client:** never expose your API key/password in client code.

---

## 5) Troubleshooting

- **CORS errors:** ensure your site origin is in `ALLOWED_ORIGINS` and redeploy.
- **401/403:** confirm `F1_API_KEY` / `F1_API_PASSWORD` are set in the current environment.
- **404 from upstream:** double-check endpoint paths against Florist One docs.
- **JSON errors:** some errors may return non-JSON; gate `res.json()` by content-type.

---

## 6) License
MIT
