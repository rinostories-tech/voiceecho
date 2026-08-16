// POST /api/rewrite  —  the paywall + the rewrite.
// Enforces a MONTHLY quota (prices are shown weekly, metered monthly),
// uses a saved voice fingerprint or a library style, never charges for a
// refusal, and saves each successful rewrite to history.
//
// All prompt text lives in _prompt.js so this endpoint and /api/demo can't
// drift apart. Nothing in this file should contain prompt wording.

import {
  MODEL,
  buildSystem,
  buildExtras,
  savedVoiceProfile,
  fingerprintProfile,
  lengthDirective,
  SURFACE_FORMATS,
  FORMAT_REMINDER,
  looksLikeRefusal,
  USER_MSG,
} from "../_prompt.js";

const ADMIN_EMAIL = "rinostories@gmail.com"; // may use overridePlan to test any tier

// Monthly rewrite limits — keep in sync with app/index.html PLANS.
const MONTHLY = { free:15, starter:200, pro:600, studio:1500, lifetime:100000 };
// Per-rewrite input character limits — keep in sync with app/index.html + pricing cards.
const CHARLIMIT = { free:1000, starter:3000, pro:8000, studio:Infinity, lifetime:Infinity };
const CHANNELS_ALLOWED = { free:false, starter:false, pro:true, studio:true, lifetime:true };

const LIBRARY = {
  // serious / real use cases
  punchy:"Short, direct, high-energy. Cut filler, lead with the point, keep sentences tight.",
  warm:"Warm, human and relaxed, like talking to a friend. A little informal, genuinely kind.",
  clear:"Plain and clear. Simple words, no jargon, short sentences, easy to skim.",
  professional:"Polished and professional. Complete sentences, respectful register, no slang.",
  analytical:"Measured and precise. Evidence-led, careful claims, no hype or exaggeration.",
  story:"Narrative and vivid. Set a scene, carry one thread, land an ending.",
  bold:"Confident and opinionated. Take a clear stance, own it, no hedging.",
  closer:"Persuasive and benefit-led. Build a little tension and drive to one clear call to action.",
  technical:"Technical and exact. Unambiguous, well-structured, correct terminology, no fluff.",
  support:"Calm, empathetic customer-support tone. Acknowledge, reassure, give the next step.",
  exec:"Executive brief. Decision-first, TL;DR up top, ruthless about length.",
  creator:"Casual social-native creator voice. Snappy, hooky, a strong first line.",
  // for fun (personas — generic, not real people)
  pirate:"Rewrite as a swashbuckling pirate: nautical slang, 'arr', 'matey', salty and fun.",
  bard:"Rewrite in theatrical Elizabethan English: thee/thou/thy, flowery, Shakespearean flourish.",
  buzzword:"Rewrite as a corporate-jargon overlord: synergy, leverage, circle back, drive alignment — maximum buzzwords, played straight.",
  genz:"Rewrite in Gen Z internet slang: lowercase, 'no cap', 'lowkey', 'it's giving', playful.",
  cowboy:"Rewrite as a rugged cowboy: frontier drawl, 'reckon', 'partner', 'much obliged'.",
  noir:"Rewrite as a hard-boiled 1940s noir detective: moody, clipped, world-weary metaphors.",
  zen:"Rewrite as a calm zen master: spare, serene, almost koan-like, unhurried.",
  drama:"Rewrite as an over-dramatic theatre kid: grand, breathless, everything is EVERYTHING.",
};

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

  // 2. input
  const body = await request.json().catch(() => ({}));
  const {
    draft = "", voiceId = null, libraryStyle = null, channel = "Auto",
    samples = "", overridePlan = null, length = null, wordMin = null, wordMax = null,
  } = body;
  if (!draft.trim()) return json({ error: "Add a draft to rewrite." }, 400);

  // 3. plan + limit
  const planRes = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=plan,usage_month,usage_count&id=eq.${userId}`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
  });
  const prof = (await planRes.json().catch(() => []))?.[0] || {};
  let plan = prof.plan || "free";
  // admin-only: let the dev toggle actually exercise any tier end-to-end
  const isAdmin = (email || "").toLowerCase() === ADMIN_EMAIL;
  if (isAdmin && overridePlan && MONTHLY[overridePlan] != null) plan = overridePlan;
  const limit = MONTHLY[plan] ?? 15;

  // 3a. per-plan character limit on the draft (checked before the model is called)
  const charLimit = CHARLIMIT[plan] ?? CHARLIMIT.free;
  if (draft.trim().length > charLimit) {
    return json({
      error: `Your plan allows up to ${charLimit} characters per rewrite. Upgrade to rewrite longer drafts.`,
      code: "CHAR_LIMIT",
      charLimit,
    }, 403);
  }

  // 3b. pre-check quota (don't call the model if already out)
  const nowM = new Date().toISOString().slice(0, 7);
  const usedNow = prof.usage_month === nowM ? (prof.usage_count || 0) : 0;
  if (usedNow >= limit) return json({ error: "Out of rewrites this month", code: "QUOTA" }, 402);

  // 4. resolve the voice
  //
  // Saved voices now send the distilled fingerprint AND the raw training text.
  // The bullets alone lose sentence rhythm, which is the thing that makes a
  // rewrite read as the same author — that's why the app used to come back
  // blander than the demo, which always had the raw samples.
  let voiceProfile = "", voiceName = "";
  if (voiceId) {
    const vRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/voices?select=name,fingerprint,samples&id=eq.${voiceId}&user_id=eq.${userId}`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } },
    );
    const v = (await vRes.json().catch(() => []))?.[0];
    if (!v) return json({ error: "That voice wasn't found." }, 404);
    voiceProfile = savedVoiceProfile(v.fingerprint, v.samples);
    voiceName = v.name;
  } else if (libraryStyle && LIBRARY[libraryStyle]) {
    voiceProfile = LIBRARY[libraryStyle];
    voiceName = libraryStyle;
  } else if (samples.trim().length >= 40) {
    // was a broken paste: the template literal contained the source line as text,
    // so this path sent the model the string "voiceProfile = fingerprintProfile(samples);"
    voiceProfile = fingerprintProfile(samples.trim());
    voiceName = "quick";
  } else {
    return json({ error: "Pick a voice or a library style." }, 400);
  }

  // 5. build the prompt
  //
  // Surface format and length are Pro+ and get their own top-level MANDATORY
  // sections — nested under TARGET VOICE they read as flavour text about the
  // voice rather than directives, which is why they used to no-op.
  const gateOpen = !!CHANNELS_ALLOWED[plan];
  const channelGuide = gateOpen && SURFACE_FORMATS[channel] ? SURFACE_FORMATS[channel] : "";
  const useChannel = !!channelGuide;

  const draftWords = (draft.trim().match(/\S+/g) || []).length;   // concrete anchor for the model
  const len = gateOpen
    ? lengthDirective({ length, wordMin, wordMax, draftWords })
    : { section: "", reminder: "", tokenTarget: 0 };

  const system = buildSystem(voiceProfile, buildExtras({ channelGuide, lengthSection: len.section }));

  // Mandatory constraints are restated after the draft in the user turn. Haiku
  // weights the last thing it reads far more heavily than a directive several
  // hundred tokens up in the system prompt.
  const reminders = [useChannel ? FORMAT_REMINDER[channel] : "", len.reminder]
    .filter(Boolean)
    .join("\n");

  // give the model room when a long output is expected
  let maxTokens = 1200;
  if (len.tokenTarget > 0) maxTokens = Math.min(4096, Math.max(1200, Math.ceil(len.tokenTarget * 2.4) + 200));

  // 6. call the model (abort if the client disconnects → no charge)
  let aiRes;
  try {
    aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: request.signal,
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: USER_MSG(draft, reminders) }],
      }),
    });
  } catch (e) {
    // client cancelled / connection dropped — do NOT spend a rewrite
    return json({ error: "Cancelled.", code: "ABORTED" }, 499);
  }
  if (request.signal?.aborted) return json({ error: "Cancelled.", code: "ABORTED" }, 499);
  if (!aiRes.ok) return json({ error: "The model is busy — try again in a moment." }, 502);
  const ai = await aiRes.json();
  const output = (ai?.content?.[0]?.text || "").trim();
  if (!output) return json({ error: "Empty response — try again." }, 502);

  // 7. refusal → no charge, no history
  if (looksLikeRefusal(output)) {
    return json({ error: "We couldn't rewrite that one — and we didn't count it against your quota.", code: "REFUSAL" }, 409);
  }

  // 8. spend one rewrite (atomic, race-safe) — last abort check so a cancel never charges
  if (request.signal?.aborted) return json({ error: "Cancelled.", code: "ABORTED" }, 499);
  const spend = await sbAdmin(env, "use_rewrite", { uid: userId, monthly_limit: limit });
  const remaining = await spend.json().catch(() => null);
  if (remaining === null || remaining === undefined) {
    return json({ error: "Out of rewrites this month", code: "QUOTA" }, 402);
  }

  // 9. count scrubbed AI-isms (rough, for the UI badge)
  const isms = /\b(delve|in today's landscape|it's important to note|unlock|seamless|robust|tapestry|testament to|elevate|navigate the complexities)\b/gi;
  const scrubbed = ((draft.match(isms) || []).length);

  // 10. save history (best-effort)
  await fetch(`${env.SUPABASE_URL}/rest/v1/history`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      user_id: userId, voice_id: voiceId, voice_name: voiceName,
      style: useChannel ? channel : "Auto", draft, output,
    }),
  }).catch(() => {});

  return json({
    output,
    used: limit - remaining,
    limit,
    remaining,
    scrubbed,
    charLimit: charLimit === Infinity ? null : charLimit,
  });
}
