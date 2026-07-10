// POST /api/train-voice  —  build a voice fingerprint from writing samples.
// Runs server-side (the Anthropic key never touches the browser). Training is
// free (it doesn't spend a monthly rewrite), but it IS capped per plan.

const MODEL = "claude-haiku-4-5-20251001";
const ADMIN_EMAIL = "rinostories@gmail.com";

// Keep in sync with app/index.html PLANS and rewrite.js
const VOICE_CAP = { free:1, starter:3, pro:10, studio:25, lifetime:9999 };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const sbAdmin = (env, path, body) =>
  fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: env.SUPABASE_SERVICE_KEY },
    body: JSON.stringify(body),
  });

// Analyse writing samples → compact voice fingerprint. Returns null on API failure,
// "" on an empty analysis, or the fingerprint text.
async function buildFingerprint(env, samples) {
  const system =
    "You analyse a person's writing samples and produce a compact VOICE FINGERPRINT another model can follow to write like them. " +
    "Capture: tone and register; sentence length and rhythm; punctuation habits; vocabulary and go-to phrases; how they open and close; " +
    "quirks (contractions, dashes, emoji, capitalisation); and what they avoid. Output 5-9 tight bullet points, no preamble, no quotes of the samples.";
  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 600, system,
      messages: [{ role: "user", content: `Writing samples:\n\n${samples}` }],
    }),
  });
  if (!aiRes.ok) return null;
  const ai = await aiRes.json().catch(() => null);
  return (ai?.content?.[0]?.text || "").trim();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. who is this?
  const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!token) return json({ error: "Not signed in" }, 401);
  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return json({ error: "Invalid session" }, 401);
  const { id: userId, email } = await userRes.json();

  // 2. validate input
  const { name = "", samples = "", overridePlan = null, voiceId = null, regenerate = true } = await request.json().catch(() => ({}));
  if (!name.trim()) return json({ error: "Give the voice a name." }, 400);

  // ── EDIT MODE: update an existing voice. No cap check (not a new voice).
  //    Service-key patch, scoped to this user's row. Rebuilds the fingerprint
  //    from the edited samples unless it's a name-only change.
  if (voiceId) {
    const ownRes = await fetch(`${env.SUPABASE_URL}/rest/v1/voices?select=id&id=eq.${voiceId}&user_id=eq.${userId}`, {
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
    });
    const owns = (await ownRes.json().catch(() => []))?.[0];
    if (!owns) return json({ error: "That voice wasn't found." }, 404);

    let patch = { name: name.trim() };
    if (regenerate !== false) {
      if (samples.trim().length < 60) return json({ error: "Add more sample text for a good fingerprint." }, 400);
      const fp = await buildFingerprint(env, samples);
      if (fp === null) return json({ error: "Couldn't analyse the samples — try again." }, 502);
      if (!fp) return json({ error: "Empty analysis — try again." }, 502);
      patch = { name: name.trim(), samples: samples.trim(), fingerprint: fp };
    }
    const upRes = await fetch(`${env.SUPABASE_URL}/rest/v1/voices?id=eq.${voiceId}&user_id=eq.${userId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(patch),
    });
    if (!upRes.ok) return json({ error: "Couldn't save the voice." }, 500);
    const urows = await upRes.json().catch(() => []);
    const uv = urows?.[0] || {};
    return json({ id: uv.id, name: uv.name, updated: true });
  }

  if (samples.trim().length < 60) return json({ error: "Add more sample text for a good fingerprint." }, 400);

  // 3. plan cap check (server-side, authoritative)
  const planRes = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=plan&id=eq.${userId}`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
  });
  const planRows = await planRes.json().catch(() => []);
  let userPlan = (planRows?.[0]?.plan) || "free";
  const isAdmin = (email || "").toLowerCase() === ADMIN_EMAIL;
  if (isAdmin && overridePlan && VOICE_CAP[overridePlan] != null) userPlan = overridePlan;
  const cap = VOICE_CAP[userPlan] ?? 1;

  const countRes = await sbAdmin(env, "voice_count", { uid: userId });
  const count = await countRes.json().catch(() => 0);
  if (typeof count === "number" && count >= cap) {
    return json({ error: `Your plan allows ${cap} voice${cap > 1 ? "s" : ""}.`, code: "VOICE_CAP" }, 402);
  }

  // 4. extract the fingerprint with the model
  const fingerprint = await buildFingerprint(env, samples);
  if (fingerprint === null) return json({ error: "Couldn't analyse the samples — try again." }, 502);
  if (!fingerprint) return json({ error: "Empty analysis — try again." }, 502);

  // 5. save the voice (service key insert; RLS-safe because we set user_id)
  const insRes = await fetch(`${env.SUPABASE_URL}/rest/v1/voices`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ user_id: userId, name: name.trim(), fingerprint, samples: samples.trim() }),
  });
  if (!insRes.ok) return json({ error: "Couldn't save the voice." }, 500);
  const rows = await insRes.json();
  const voice = rows?.[0] || {};
  return json({ id: voice.id, name: voice.name });
}
