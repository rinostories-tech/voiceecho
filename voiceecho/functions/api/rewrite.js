// POST /api/rewrite  —  this Function IS the paywall.
// It runs on Cloudflare's servers. The user never sees the API key,
// and can't reach the model without passing the credit check below.

const MODEL = "claude-haiku-4-5-20251001"; // cheap + fast for high-volume rewrites; bump to sonnet for quality

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function onRequestPost(context) {
  const { request, env } = context;

  // ---- 1. WHO IS THIS? Verify the Supabase login token ----
  const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!token) return json({ error: "Not signed in" }, 401);

  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return json({ error: "Invalid session" }, 401);
  const { id: userId } = await userRes.json();

  // ---- 2. THE GATE: spend one credit, atomically ----
  // spend_credit() subtracts 1 only if credits > 0, and returns the new balance
  // (or null if they had none). Doing it in the DB avoids race conditions where
  // someone fires 10 requests at once to get 10 rewrites off 1 credit.
  const spendRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/spend_credit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ uid: userId }),
  });
  const remaining = await spendRes.json();
  if (remaining === null || remaining === undefined) {
    return json({ error: "Out of credits", code: "NO_CREDITS" }, 402); // 402 = Payment Required
  }

  // ---- 3. DO THE WORK: only reached if a credit was successfully spent ----
  const { samples = "", draft = "", tone = "auto" } = await request.json();
  if (samples.trim().length < 40 || !draft.trim()) {
    // give the credit back if the input was junk
    await addBack(env, userId);
    return json({ error: "Need writing samples and a draft" }, 400);
  }

  const toneLine =
    tone === "auto"
      ? "Match the tone, rhythm and register of the samples exactly."
      : `Bias the voice toward a ${tone} tone, while still honouring the samples.`;

  const system = `You are a voice-matching rewriting engine. Given 2-3 writing samples from one person and a draft, rewrite the draft so it reads as if that person wrote it.
- Study the samples for sentence length, rhythm, punctuation, vocabulary, and how they open/close thoughts.
- ${toneLine}
- Preserve the draft's meaning and every concrete fact. Never invent claims.
- Strip generic AI phrasing ("in today's landscape", "it's important to note", "delve", "moreover").
- Return ONLY the rewritten text. No preamble, no quotes.`;

  try {
    const ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system,
        messages: [
          {
            role: "user",
            content: `WRITING SAMPLES:\n"""${samples}"""\n\nDRAFT TO REWRITE:\n"""${draft}"""`,
          },
        ],
      }),
    });
    const data = await ai.json();
    const output = (data.content || []).map((b) => b.text || "").join("").trim();
    if (!output) throw new Error("empty");
    return json({ output, creditsLeft: remaining });
  } catch (e) {
    await addBack(env, userId); // model failed → don't charge them
    return json({ error: "Rewrite failed, credit refunded" }, 502);
  }
}

// refund one credit if we took payment but couldn't deliver
function addBack(env, userId) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/rpc/add_credits`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ uid: userId, amount: 1 }),
  });
}
