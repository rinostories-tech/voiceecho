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
// RATE LIMITING — requires a KV namespace bound as DEMO_KV (dashboard → project →
// Settings → Bindings, Production AND Preview, then redeploy).
//
//   paired mode : DAILY_RUNS per IP per day, then the signup wall.
//                 FAILS CLOSED. If the binding is missing or KV errors, visitors
//                 get the wall instead of a free rewrite. A broken binding should
//                 cost us signups-that-convert-later, never an uncapped API bill.
//                 (This endpoint previously failed open, which meant the wall
//                 never fired for anyone. Don't reintroduce that.)
//
//   hero mode   : HERO_RUNS per IP per day — an abuse ceiling, not a funnel gate.
//                 FAILS OPEN, deliberately: the teaser is the first thing a
//                 visitor touches and a dead button on the hero is worse than the
//                 residual cost risk. The MAX_DRAFT cap plus the monthly spend
//                 limit on the Anthropic key are the backstop there.

import { CONTROL_SYSTEM, buildSystem, fingerprintProfile, buildReminders, callModel, looksLikeRefusal }
  from "./_prompt.js";

const DAILY_RUNS = 3;      // paired runs per IP, then the wall
const HERO_RUNS  = 20;     // teaser runs per IP — won't touch a real visitor
const MAX_SAMPLE = 1200;   // ~200 words of their writing — plenty for a fingerprint
const MAX_DRAFT  = 600;    // ~100 words in
const MIN_SAMPLE = 120;    // below this there's no signal and the demo looks broken
const KV_TTL     = 172800; // 48h covers any timezone

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// Single wall response, used for quota-reached AND for any KV failure.
const wall = (msg) => json({ gated: true, error: msg }, 429);

const WALL_QUOTA   = "That's your three free runs. Make an account to keep going — it's free, no card.";
const WALL_NO_KV   = "Make a free account to run the proof demo — it's free, no card.";

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

  const ip  = request.headers.get("CF-Connecting-IP") || "anon";
  const day = new Date().toISOString().slice(0, 10);
  const key = `demo:${day}:${ip}`;
  let used = 0;

  // ---- rate limit, before we spend anything ----
  if (paired) {
    // No binding → wall. Never a free rewrite.
    if (!env.DEMO_KV) return wall(WALL_NO_KV);

    try {
      used = parseInt(await env.DEMO_KV.get(key), 10) || 0;
    } catch {
      return wall(WALL_NO_KV);           // KV unreachable → wall, not a freebie
    }

    if (used >= DAILY_RUNS) return wall(WALL_QUOTA);
  }

  try {
    if (!paired) {
      // Hero teaser: cheap abuse ceiling. Counts attempts, not successes — a
      // script hammering us shouldn't get free retries off failed calls.
      const heroKey = `hero:${day}:${ip}`;
      if (env.DEMO_KV) {
        try {
          const heroUsed = parseInt(await env.DEMO_KV.get(heroKey), 10) || 0;
          if (heroUsed >= HERO_RUNS) {
            return json({ error: "Try again tomorrow, or make a free account." }, 429);
          }
          await env.DEMO_KV.put(heroKey, String(heroUsed + 1), { expirationTtl: KV_TTL });
        } catch {
          // Fail open — see header note. Don't kill the hero over a KV blip.
        }
      }

      // A described voice, not a real writer: no sample to be faithful to, so
      // the voice reminder doesn't apply and every punctuation tell is stripped.
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
    // The control has no writer to be faithful to: no voice reminder, and every
    // punctuation tell normalised. The voiced side gets both — the reminder so the
    // voice survives to the point of generation, and the visitor's own sample so
    // the punctuation policy is derived from their actual writing rather than
    // imposed on it. If they use dashes, they keep them.
    const [control, voiced] = await Promise.all([
      callModel(env, {
        system: CONTROL_SYSTEM,
        draft,
        signal: request.signal,
      }),
      callModel(env, {
        system: buildSystem(fingerprintProfile(sample)),
        draft,
        reminders: buildReminders({ hasVoice: true }),
        voiceSamples: sample,
        signal: request.signal,
      }),
    ]);

    if (looksLikeRefusal(voiced) || looksLikeRefusal(control)) {
      return json({ error: "Couldn't rewrite that one — try different text. This run didn't count." }, 409);
    }

    // Only a successful paired run is metered. A write failure here can't be
    // allowed to 500 a rewrite the visitor already paid latency for — worst
    // case they get one extra run, which is the right way round to be wrong.
    try {
      await env.DEMO_KV.put(key, String(used + 1), { expirationTtl: KV_TTL });
    } catch { /* counted next time */ }

    const remaining = Math.max(0, DAILY_RUNS - (used + 1));
    return json({ control, voiced, remaining, nextIsWall: remaining === 0 });

  } catch (e) {
    if (request.signal?.aborted) return json({ error: "Cancelled.", code: "ABORTED" }, 499);
    return json({ error: "The model is busy — try again in a moment." }, 502);
  }
}
