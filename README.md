WayTrace GPS — Local development & Stripe test

Quick start (client only):

1. Run a local static server from project root:
```powershell
cd "d:\Websites\GPSTracking"
python -m http.server 8000
```
2. Open http://localhost:8000 and use `Continue (Test mode)` to bypass payment for local testing.

Stripe server (optional):

1. Install dependencies: `npm init -y && npm i express stripe`.
2. Set `STRIPE_SECRET` environment variable to your Stripe secret key.
3. Run `node server/stripe-server.js` and update client to call `/create-checkout-session` on your server.

Notes:
- Client mock payment remains in place for quick testing.
- For production, validate payment server-side and persist purchases before unlocking journeys.
