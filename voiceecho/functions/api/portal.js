// POST /api/portal  —  sends a signed-in paying user to Stripe's Customer Portal
// so they can update their card, see invoices, or cancel.
//
// Your terms and /refunds both promise "cancel any time from your account".
// This endpoint is what makes that sentence true.

const STRIPE_VERSION = "2025-03-31.basil";

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = new URL(request.url).origin;

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "not signed in" }, 401);

  const user = await getUser(env, token);
  if (!user?.id) return json({ error: "bad session" }, 401);

  // Which Stripe customer is this? Written by the webhook on first purchase.
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=stripe_customer_id`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const rows = await res.json().catch(() => []);
  const customer = rows?.[0]?.stripe_customer_id;

  // Free users and lifetime buyers who never subscribed have nothing to manage.
  if (!customer) {
    console.log(`[portal] ${user.id} has no stripe_customer_id`);
    return json({ error: "no billing account" }, 404);
  }

  const r = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_VERSION,
    },
    body: new URLSearchParams({ customer, return_url: `${origin}/app` }),
  });

  const data = await r.json();
  if (!r.ok) {
    console.log(`[portal] stripe ${r.status}: ${data?.error?.message}`);
    return json({ error: "could not open portal" }, 502);
  }

  return json({ url: data.url });
}

async function getUser(env, token) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
