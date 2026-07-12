// POST /api/webhook  —  Lemon Squeezy calls this after a payment.
// Its ONE job: put the buyer on the plan they paid for by setting profiles.plan,
// which is the field rewrite.js and the app read to gate everything.
// It must verify the signature, or anyone who finds the URL could POST fake
// payments and upgrade themselves for free.

// Every value that can arrive in custom_data.plan (set by the checkout link) →
// the ACTUAL tier stored on the user. Annual variants collapse to their base
// tier, because the plan matrix only knows free/starter/pro/studio/lifetime.
const PLAN_TIER = {
  starter:        "starter",
  starter_annual: "starter",
  pro:            "pro",
  pro_annual:     "pro",
  studio:         "studio",
  studio_annual:  "studio",
  lifetime:       "lifetime",
};

// Events that GRANT access. order_created + subscription_created both fire for a
// new subscription — that's fine, setPlan is idempotent. subscription_payment_success
// fires on every renewal, keeping the plan alive. (An annual sub keeps its plan set
// all year; the monthly rewrite allowance auto-resets by calendar month in rewrite.js,
// so there's nothing to top up between renewals.)
const GRANT  = new Set(["order_created", "subscription_created", "subscription_payment_success"]);
// A "cancelled" sub keeps access until it runs out, so only drop to free on expiry.
const REVOKE = new Set(["subscription_expired"]);

export async function onRequestPost(context) {
  const { request, env } = context;

  // read the raw body BEFORE parsing — signature is computed over raw bytes
  const raw = await request.text();

  // ---- verify it's really from Lemon Squeezy ----
  const sig = request.headers.get("X-Signature") || "";
  const valid = await verifyHmac(raw, sig, env.LEMONSQUEEZY_WEBHOOK_SECRET);
  if (!valid) {
    console.log("[webhook] BAD SIGNATURE — rejected");
    return new Response("bad signature", { status: 401 });
  }

  const event  = JSON.parse(raw);
  const name   = event?.meta?.event_name;
  const test   = event?.data?.attributes?.test_mode ? " (TEST)" : "";
  const userId = event?.meta?.custom_data?.user_id;
  const plan   = event?.meta?.custom_data?.plan;   // e.g. "pro" or "pro_annual"

  console.log(`[webhook]${test} event=${name} user=${userId} plan=${plan}`);

  if (GRANT.has(name)) {
    const tier = PLAN_TIER[plan];
    if (!userId) { console.log("[webhook] no user_id in custom_data — ignored"); return ok("no user_id"); }
    if (!tier)   { console.log(`[webhook] unknown plan "${plan}" — ignored`);     return ok("unknown plan"); }

    const status = await setPlan(env, userId, tier);
    console.log(`[webhook] setPlan ${userId} -> ${tier} :: ${status}`);   // 204 = success
    return ok(`granted ${tier}`);
  }

  if (REVOKE.has(name)) {
    if (userId) {
      const status = await setPlan(env, userId, "free");
      console.log(`[webhook] revoked ${userId} -> free :: ${status}`);
    }
    return ok("revoked");
  }

  return ok("ignored");
}

// set the user's tier on their profile row (this is what rewrite.js + the app read)
async function setPlan(env, userId, tier) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ plan: tier }),
  });
  return res.status;
}

const ok = (msg) => new Response(msg || "ok", { status: 200 });

async function verifyHmac(body, signatureHex, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return expected === signatureHex;
}
