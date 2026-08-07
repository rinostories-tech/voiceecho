// POST /api/demo — public homepage demo. No auth, no login, no history.
//
// TWO MODES, one endpoint:
//   { draft }          → hero-card teaser. One rewrite into a neutral human voice.
//   { draft, sample }  → the proof demo. TWO rewrites of the same draft in
//                        parallel: a fair control, and one fingerprinted to the
//                        visitor's own writing. The gap between them IS the product.
//
// Model, guard rails, fingerprint instruction and refusal handling all come from
// ./_prompt.js — the same module /api/rewrite uses. They must not drift: a demo
// that beats the app is a refund, and an app that beats the demo undersells.
//
// Rate limited to DAILY_RUNS per IP per day via KV. The old endpoint was an
// unauthenticated proxy to our Anthropic key with no quota at all; a 200-char
// cap limits cost per call, not calls per second. The cap also does the real
// job — it forces the signup.
//
// Requires a KV namespace bound as DEMO_KV (dashboard → project → Settings →
// Bindings). Fails OPEN if the binding is missing, so verify it after deploying.

import { CONTROL_SYSTEM, buildSystem, fingerprintProfile, callModel, looksLikeRefusal }
  from "./_prompt.js";

const DAILY_RUNS = 3;      // per IP, then the wall
const MAX_SAMPLE = 1200;   // ~200 words of their writing — plenty for a fingerprint
const MAX_DRAFT  = 600;    // ~100 words in
const MIN_SAMPLE = 120;    // below this there's no signal and the demo looks broken

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// The hero teaser has no sample to work from, so it gets a described voice
// rather than a fingerprint. Same rule set, same assembly path.
const HUMAN_PROFILE =
  "Write like a real, natural human — warm, clear, direct and a little punchy. Vary your sentence " +
  "lengths noticeably: mix short blunt sentences with longer ones. Use contractions. Avoid uniform rhythm.";

export async function onRequestPost(context) {
  const { request, env } = context;

  const body   = await request.json().catch(() => ({}));
  const draft  = (body.draft  || "").toString().slice(0, MAX_DRAFT).trim();
  const sample = (body.sample || "").toString().slice(0, MAX_SAMPLE).trim();
  const paired = sample.length > 0;

  if (!draft) return json({ error: "Type a sentence first.", field: "draft" }, 400);
  if (paired && sample.length < MIN_SAMPLE) {
    return json({
      error: `Needs about ${MIN_SAMPLE} characters to read your style — roughly two sentences.`,
      field: "sample",
    }, 400);
  }

  // ---- rate limit, before we spend anything ----
  // Only the paired mode is metered: the hero teaser is top-of-funnel and cheap.
  const ip  = request.headers.get("CF-Connecting-IP") || "anon";
  const day = new Date().toISOString().slice(0, 10);
  const key = `demo:${day}:${ip}`;
  let used = 0;

  if (paired && env.DEMO_KV) {
    used = parseInt(await env.DEMO_KV.get(key), 10) || 0;
    if (used >= DAILY_RUNS) {
      return json({
        gated: true,
        error: "That's your three free runs. Make an account to keep going — it's free, no card.",
      }, 429);
    }
  }

  try {
    if (!paired) {
      const output = await callModel(env, {
        system: buildSystem(HUMAN_PROFILE),
        draft,
        signal: request.signal,
      });
      if (looksLikeRefusal(output)) {
        return json({ error: "Couldn't rewrite that one — try different text." }, 409);
      }
      return json({ output });
    }

    // Both rewrites at once — one round trip of latency, not two.
    const [control, voiced] = await Promise.all([
      callModel(env, { system: CONTROL_SYSTEM, draft, signal: request.signal }),
      callModel(env, { system: buildSystem(fingerprintProfile(sample)), draft, signal: request.signal }),
    ]);

    if (looksLikeRefusal(voiced) || looksLikeRefusal(control)) {
      return json({ error: "Couldn't rewrite that one — try different text. This run didn't count." }, 409);
    }

    if (env.DEMO_KV) {
      await env.DEMO_KV.put(key, String(used + 1), { expirationTtl: 172800 }); // 48h covers any TZ
    }

    const remaining = Math.max(0, DAILY_RUNS - (used + 1));
    return json({ control, voiced, remaining, nextIsWall: remaining === 0 });

  } catch (e) {
    if (request.signal?.aborted) return json({ error: "Cancelled.", code: "ABORTED" }, 499);
    return json({ error: "The model is busy — try again in a moment." }, 502);
  }
}
