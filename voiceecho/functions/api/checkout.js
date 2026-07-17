// POST /api/checkout  —  the ONLY place in this codebase that may create a
// Stripe Checkout Session.
//
// Why "only": managed_payments[enabled]=true is what makes Stripe the merchant
// of record for a sale. It is per-session, not per-account. A session created
// WITHOUT that flag still takes the money and looks completely normal — but on
// that sale YOU are the seller, and you personally owe the VAT/GST. So there is
// exactly one door, and the flag is nailed to it.
//
// The browser only ever sends a plan KEY ("pro_annual"). Price IDs live here,
// server-side, so they can be rotated without touching the front end and a
// visitor can't tamper with what they're charged.

const PRICE_IDS = {
  starter:        "price_1Tu3KFJ8InSq3TKEUWGE8FIj",   // $11.99  / month
  starter_annual: "price_1Tu3LJJ8InSq3TKEntyxk7vw",   // $119.99 / year
  pro:            "price_1Tu3MrJ8InSq3TKEPzeljD82",   // $19.99  / month
  pro_annual:     "price_1Tu3NuJ8InSq3TKEzoYSvuDa",   // $199.99 / year
  studio:         "price_1Tu3RKJ8InSq3TKEDhkvWGnU",   // $31.99  / month
  studio_annual:  "price_1Tu3SDJ8InSq3TKEpSjuzwCy",   // $319.99 / year
  lifetime:       "price_1Tu3T6J8InSq3TKEOp393Rp0",   // $240    once
};

// Lifetime is a one-off; everything else is a subscription.
const MODE = (plan) => (plan === "lifetime" ? "payment" : "subscription");

// Pin the API version explicitly. Do NOT rely on the account default — if that
// drifts, "am I merchant of record" silently changes with it.
const STRIPE_VERSION = "2025-03-31.basil";

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = new URL(request.url).origin;

  // ---- who is asking? ----
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "not signed in" }, 401);

  const user = await getUser(env, token);
  if (!user?.id) return json({ error: "bad session" }, 401);

  // ---- what are they buying? ----
  let plan = "";
  try { plan = (await request.json())?.plan || ""; } catch (e) {}

  const price = PRICE_IDS[plan];
  if (!price) {
    console.log(`[checkout] unknown plan "${plan}" — rejected`);
    return json({ error: "unknown plan" }, 400);
  }

  // ---- build the session ----
  // NOTE: automatic_tax, tax_id_collection, payment_method_types and friends are
  // deliberately absent. Managed Payments forbids them — Stripe does tax and
  // payment-method selection itself now. Adding them back errors the session.
  const params = {
    mode: MODE(plan),
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    "managed_payments[enabled]": "true",

    // Two belts, one braces. client_reference_id survives on the session;
    // subscription_data.metadata rides onto the Subscription so that RENEWAL
    // events (which carry no session) still know who the user is.
    client_reference_id: user.id,
    "metadata[user_id]": user.id,
    "metadata[plan]": plan,

    success_url: `${origin}/app?upgraded=1`,
    cancel_url: `${origin}/#pricing`,
  };

  if (MODE(plan) === "subscription") {
    params["subscription_data[metadata][user_id]"] = user.id;
    params["subscription_data[metadata][plan]"] = plan;
  }

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_VERSION,
    },
    body: new URLSearchParams(params),
  });

  const data = await res.json();

  if (!res.ok) {
    // Log the real reason server-side; tell the browser nothing useful.
    console.log(`[checkout] stripe ${res.status}: ${data?.error?.message} (param: ${data?.error?.param})`);
    return json({ error: "could not start checkout" }, 502);
  }

  console.log(`[checkout] ${user.id} -> ${plan} :: ${data.id}`);
  return json({ url: data.url });
}

// Verify the Supabase access token and get the user it belongs to.
// This is what stops someone POSTing {plan:"lifetime"} with a made-up user id.
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
