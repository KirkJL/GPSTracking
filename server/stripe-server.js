// Minimal Express server to create Stripe Checkout sessions.
// Usage: set STRIPE_SECRET and run `node stripe-server.js`.
// This example is for demonstration only — secure your server for production.

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET || '');
const app = express();
app.use(express.json());

app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'gbp', product_data: { name: 'WayTrace journey' }, unit_amount: 500 }, quantity: 1 }],
      mode: 'payment',
      success_url: (req.headers.origin || 'http://localhost:8000') + '/?checkout=success',
      cancel_url: (req.headers.origin || 'http://localhost:8000') + '/?checkout=cancel'
    });
    res.json({ id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(4242, () => console.log('Stripe server listening on :4242'));
