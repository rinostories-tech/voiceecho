// POST /api/webhook  —  Lemon Squeezy calls this after a payment.
// This is what grants a paid plan. It must verify the signature, or anyone
// who finds the URL could POST fake payments and upgrade themselves for free.

// Every value that can arrive in custom_data.plan (from the checkout link) →
// the ACTUAL tier stored on the user. Annual variants collapse to their base
// tier, because the app's plan matrix only knows free/starter/pro/studio/lifetime.
const PLAN_TIER = {
  starter:        "starter",
  starter_annual: "starter",
  pro:            "pro",
  pro_annual:     "pro",
  studio:         "studio",
  studio_annual:  "studio",
  lifetime:       "lifetime",
};

// Optional credit top-up per tier (legacy — see note in the message).
// Gating in the app is driven by profiles.plan + monthly usage, not by these.
const CREDITS_FOR = {
  starter:  150,
  pro:      500,
  studio:   2000,
  lifetime: 100000,
};

// Events that GRANT access. Both fire for a new subscription (order + first
// payment) and that's fine — setPlan is idempotent. subscription_payment_success
// also fires on every renewal, keeping the plan alive year after year.
const GRANT  = new Set(["order_created", "subscription_created", "subscription_payment_success"]);
// When a subscription actually ends, drop them back to free. (A "cancelled" sub
// keeps access until it expires, so we only revoke on expiry.)
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

  const event = JSON.parse(raw);
  const name  = event?.meta?.event_name;
  const test  = event?.data?.attributes?.test_mode ? " (TEST)" : "";
  const userId = event?.meta?.custom_data?.user_id;
  const plan   = event?.meta?.custom_data?.plan;   // e.g. "pro" or "pro_annual"

  console.log(`[webhook]${test} event=${name} user=${userId} plan=${plan}`);

  if (GRANT.has(name)) {
    const tier = PLAN_TIER[plan];
    if (!userId) { console.log("[webhook] no user_id in custom_data — ignored"); return ok("no user_id"); }
    if (!tier)   { console.log(`[webhook] unknown plan "${plan}" — ignored`);     return ok("unknown plan"); }

    // THE IMPORTANT PART: actually put the user on the plan the app reads.
    const planned = await setPlan(env, userId, tier);
    console.log(`[webhook] setPlan ${userId} -> ${tier} :: ${planned}`);

    // Legacy credit top-up. Only on the recurring payment (or the one-time
    // lifetime order) so a new subscription doesn't get double-credited.
    if (name === "subscription_payment_success" || tier === "lifetime") {
      const amount = CREDITS_FOR[tier];
      if (amount) {
        const credited = await addCredits(env, userId, amount);
        console.log(`[webhook] addCredits ${userId} +${amount} :: ${credited}`);
      }
    }
    return ok(`granted ${tier}`);
  }

  if (REVOKE.has(name)) {
    if (userId) {
      await setPlan(env, userId, "free");
      console.log(`[webhook] revoked ${userId} -> free`);
    }
    return ok("revoked");
  }

  return ok("ignored");
}

// --- set the user's tier on their profile row (this is what loadProfile reads) ---
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
  return res.status;   // 204 = success
}

// --- legacy credit RPC (kept in case functions/api/rewrite.js still uses it) ---
async function addCredits(env, userId, amount) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/add_credits`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ uid: userId, amount }),
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
