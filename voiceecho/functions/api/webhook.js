// POST /api/webhook  —  Stripe calls this after a payment or a subscription change.
// Its ONE job: put the buyer on the plan they paid for by setting profiles.plan,
// which is the field rewrite.js and the app read to gate everything.
// It must verify the signature, or anyone who finds the URL could POST fake
// payments and upgrade themselves for free.
//
// ── What changed from Lemon Squeezy, and why the extra column ───────────────
// Lemon Squeezy stamped custom_data.user_id onto EVERY event, including renewals.
// Stripe does not. A renewal or a cancellation arrives carrying a customer id
// ("cus_...") and nothing else — no idea who that is in our database.
// So: on the first purchase we record profiles.stripe_customer_id, and every
// later event finds the user through that column. Without it, renewals and
// cancellations silently do nothing.

// Every value that can arrive in metadata.plan (set by /api/checkout) → the
// ACTUAL tier stored on the user. Annual variants collapse to their base tier,
// because the plan matrix only knows free/starter/pro/studio/lifetime.
const PLAN_TIER = {
  starter:        "starter",
  starter_annual: "starter",
  pro:            "pro",
  pro_annual:     "pro",
  studio:         "studio",
  studio_annual:  "studio",
  lifetime:       "lifetime",
};

// Subscription states that mean "they're paid up" vs "they're done".
const LIVE = new Set(["active", "trialing"]);
const DEAD = new Set(["canceled", "unpaid", "incomplete_expired"]);

export async function onRequestPost(context) {
  const { request, env } = context;

  // read the raw body BEFORE parsing — signature is computed over raw bytes
  const raw = await request.text();

  // ---- verify it's really from Stripe ----
  const sig = request.headers.get("Stripe-Signature") || "";
  const valid = await verifyStripeSig(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    console.log("[webhook] BAD SIGNATURE — rejected");
    return new Response("bad signature", { status: 401 });
  }

  const event = JSON.parse(raw);
  const name  = event?.type;
  const obj   = event?.data?.object;
  const test  = event?.livemode === false ? " (TEST)" : "";

  console.log(`[webhook]${test} event=${name}`);

  // ── 1. First purchase (subscription OR lifetime) ────────────────────────
  // This is the only event that carries the Supabase user id directly, so it's
  // the only chance to link the Stripe customer to the profile. Don't miss it.
  if (name === "checkout.session.completed") {
    const userId = obj?.client_reference_id || obj?.metadata?.user_id;
    const plan   = obj?.metadata?.plan;
    const tier   = PLAN_TIER[plan];
    const cust   = obj?.customer;

    if (!userId) { console.log("[webhook] no user id on session — ignored"); return ok("no user id"); }
    if (!tier)   { console.log(`[webhook] unknown plan "${plan}" — ignored`); return ok("unknown plan"); }

    const status = await patchProfile(env, userId, { plan: tier, stripe_customer_id: cust || null });
    console.log(`[webhook] granted ${userId} -> ${tier} (cust ${cust}) :: ${status}`);
    return ok(`granted ${tier}`);
  }

  // ── 2. Plan changed, or renewal repaired a lapsed sub ───────────────────
  if (name === "customer.subscription.updated") {
    const userId = await resolveUser(env, obj);
    if (!userId) return ok("unknown customer");

    if (DEAD.has(obj?.status)) {
      const status = await patchProfile(env, userId, { plan: "free" });
      console.log(`[webhook] sub ${obj?.status} — revoked ${userId} :: ${status}`);
      return ok("revoked");
    }
    if (LIVE.has(obj?.status)) {
      const tier = PLAN_TIER[obj?.metadata?.plan];
      if (!tier) return ok("unknown plan");
      const status = await patchProfile(env, userId, { plan: tier });
      console.log(`[webhook] sub ${obj?.status} — set ${userId} -> ${tier} :: ${status}`);
      return ok(`set ${tier}`);
    }
    // past_due / incomplete: they still have access while Stripe retries.
    return ok("no change");
  }

  // ── 3. Subscription actually ended ──────────────────────────────────────
  // A cancelled sub keeps access until the period runs out — Stripe fires this
  // at the END of that period, not when they click cancel. So dropping to free
  // here is correct and matches what the terms promise.
  if (name === "customer.subscription.deleted") {
    const userId = await resolveUser(env, obj);
    if (!userId) return ok("unknown customer");
    const status = await patchProfile(env, userId, { plan: "free" });
    console.log(`[webhook] sub ended — revoked ${userId} :: ${status}`);
    return ok("revoked");
  }

  return ok("ignored");
}

// Find the user for an event: prefer the metadata we stamped at checkout,
// fall back to the customer id column. Belt and braces — metadata can be lost
// if a subscription is ever rebuilt by hand in the dashboard.
async function resolveUser(env, obj) {
  const fromMeta = obj?.metadata?.user_id;
  if (fromMeta) return fromMeta;

  const cust = obj?.customer;
  if (!cust) return null;

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?stripe_customer_id=eq.${encodeURIComponent(cust)}&select=id`,
    { headers: sbHeaders(env) }
  );
  const rows = await res.json().catch(() => []);
  const id = rows?.[0]?.id || null;
  if (!id) console.log(`[webhook] no profile with stripe_customer_id=${cust}`);
  return id;
}

// set fields on the user's profile row (plan is what rewrite.js + the app read)
async function patchProfile(env, userId, fields) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: { ...sbHeaders(env), "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(fields),
    }
  );
  return res.status;   // 204 = success
}

const sbHeaders = (env) => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
});

const ok = (msg) => new Response(msg || "ok", { status: 200 });

// Stripe signs `${timestamp}.${rawBody}` with the endpoint secret and sends
// "t=<ts>,v1=<hex>". Recompute and compare. The timestamp check stops someone
// capturing a real event and replaying it later.
async function verifyStripeSig(body, header, secret) {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1 || !secret) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > 300) {
    console.log(`[webhook] timestamp ${age}s out of tolerance`);
    return false;
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, v1);
}

// Don't leak how much of the signature matched via how fast we said no.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
