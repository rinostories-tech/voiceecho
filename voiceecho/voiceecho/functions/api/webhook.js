// POST /api/webhook  —  Lemon Squeezy calls this after a payment.
// This is how credits get ADDED. It must verify the signature, or anyone
// who finds the URL could POST fake payments and grant themselves credits.

// Map each product/variant you create in Lemon Squeezy to a credit amount.
const CREDITS_FOR = {
  starter: 150,
  pro: 500,
  scale: 2000,
};

export async function onRequestPost(context) {
  const { request, env } = context;

  // read the raw body BEFORE parsing — signature is computed over raw bytes
  const raw = await request.text();

  // ---- verify it's really from Lemon Squeezy ----
  const sig = request.headers.get("X-Signature") || "";
  const valid = await verifyHmac(raw, sig, env.LEMONSQUEEZY_WEBHOOK_SECRET);
  if (!valid) return new Response("bad signature", { status: 401 });

  const event = JSON.parse(raw);
  const name = event?.meta?.event_name;

  // only act on successful payments
  if (name === "order_created" || name === "subscription_payment_success") {
    const attrs = event.data.attributes;
    // pass the buyer's user id + plan through checkout custom data (see README)
    const userId = event.meta?.custom_data?.user_id;
    const plan = event.meta?.custom_data?.plan;
    const amount = CREDITS_FOR[plan];

    if (userId && amount) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/add_credits`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({ uid: userId, amount }),
      });
    }
  }

  return new Response("ok", { status: 200 });
}

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
