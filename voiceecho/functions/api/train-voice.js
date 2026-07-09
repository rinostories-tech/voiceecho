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
  const { name = "", samples = "", overridePlan = null } = await request.json().catch(() => ({}));
  if (!name.trim()) return json({ error: "Give the voice a name." }, 400);
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
  const system =
    "You analyse a person's writing samples and produce a compact VOICE FINGERPRINT another model can follow to write like them. " +
    "Capture: tone and register; sentence length and rhythm; punctuation habits; vocabulary and go-to phrases; how they open and close; " +
    "quirks (contractions, dashes, emoji, capitalisation); and what they avoid. Output 5-9 tight bullet points, no preamble, no quotes of the samples.";

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: `Writing samples:\n\n${samples}` }],
    }),
  });
  if (!aiRes.ok) return json({ error: "Couldn't analyse the samples — try again." }, 502);
  const ai = await aiRes.json();
  const fingerprint = (ai?.content?.[0]?.text || "").trim();
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
    body: JSON.stringify({ user_id: userId, name: name.trim(), fingerprint }),
  });
  if (!insRes.ok) return json({ error: "Couldn't save the voice." }, 500);
  const rows = await insRes.json();
  const voice = rows?.[0] || {};
  return json({ id: voice.id, name: voice.name });
}
