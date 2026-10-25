import "server-only";
import { converse, type Turn } from "./gemini";
import { pg } from "./pg";

// Spoken check-ins: a senior tells a voice assistant how they feel, and the
// family gets a short note afterwards.
//
// Gemini runs the conversation and writes the note. It does NOT decide what is
// an emergency. Red-flag phrases are matched here, in code, for the same
// reason alert wording is templated (see summary.ts): the safety path must not
// wait on an API, fail when it fails, or be talked out of a warning. Gemini
// can add a gentler "worth following up" flag on top; it can never remove one.

/** The US number. Seniors' clocks are Eastern (migration 012), so the app is US-facing. */
export const EMERGENCY_NUMBER = "911";
/** US Suicide & Crisis Lifeline: call or text. */
const CRISIS_LINE = "988";

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 1000;
/** One open check-in alert per episode, not one per sentence. */
const ALERT_DEDUPE_MINUTES = 30;

export type Message = { from: "senior" | "assistant"; text: string };
export type Emergency = "medical" | "self_harm";

type RedFlag = { kind: Emergency; label: string; pattern: RegExp };

// Deliberately broad. A false alarm costs a phone call; a miss could cost far
// more. Phrased as speech recognition writes it: lower case, loose punctuation.
const RED_FLAGS: RedFlag[] = [
  { kind: "medical", label: "chest pain", pattern: /\bchest\b.{0,20}\b(pain|hurt|hurts|hurting|pressure|tight|tightness|heavy|squeez)|(pain|pressure|tightness|squeezing) in (my|the) chest/ },
  { kind: "medical", label: "trouble breathing", pattern: /can'?t (breathe|breath|catch my breath|get (my )?breath)|short(ness)? of breath|(trouble|difficulty|hard|struggling) (to )?breath(e|ing)?/ },
  { kind: "medical", label: "a fall", pattern: /\bi (fell|have fallen|'ve fallen)(?! asleep| in love| for)\b|\bi had a fall\b|\bfell (down|over|out of)\b|can'?t get (up|off the floor)|on the floor and can'?t/ },
  { kind: "medical", label: "possible stroke signs", pattern: /\bstroke\b|face (is )?(drooping|droopy|numb)|slurr(ed|ing)|can'?t (move|feel) my (arm|leg|face)|(numb|weak)(ness)? (on|down) (one|my left|my right|the left|the right) side/ },
  { kind: "medical", label: "fainting", pattern: /\b(fainted|passed out|blacked out|lost consciousness|keep fainting)\b/ },
  { kind: "medical", label: "heavy bleeding", pattern: /bleeding (a lot|badly|heavily|won'?t stop)|(coughing|throwing|vomiting) up blood|blood in my (vomit|stool|urine)/ },
  { kind: "medical", label: "taking too many pills", pattern: /(took|taken|take) too many (pills|tablets|medicine)|\boverdos/ },
  { kind: "self_harm", label: "thoughts of harming themselves", pattern: /kill myself|end (it all|my life)|suicid|don'?t want to (live|be alive|be here any ?more|wake up)|better off dead|hurt myself/ },
];

export function detectRedFlag(text: string): RedFlag | null {
  const lower = text.toLowerCase();
  return RED_FLAGS.find((f) => f.pattern.test(lower)) ?? null;
}

/** Fixed wording, never generated: this is the one reply that must not vary. */
export function emergencyReply(kind: Emergency, firstName: string): string {
  return kind === "self_harm"
    ? `I'm really glad you told me, ${firstName}. You don't have to go through this alone. Please call or text ${CRISIS_LINE} to talk to someone now, or call ${EMERGENCY_NUMBER} if you're in danger. I'm sending your family an alert.`
    : `That sounds serious, ${firstName}. If you have chest pain, trouble breathing, or you can't get up, please call ${EMERGENCY_NUMBER} now. I'm sending your family an alert.`;
}

export function greeting(firstName: string): string {
  return `Hello ${firstName}. I'd like to hear how you're feeling today. When we're done, I'll write a short note for your family. How are you feeling?`;
}

/** Rejects anything that isn't a plausible conversation, before it reaches the model. */
export function parseMessages(value: unknown): Message[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;
  const messages: Message[] = [];
  for (const m of value) {
    if (!m || (m.from !== "senior" && m.from !== "assistant") || typeof m.text !== "string") return null;
    const text = m.text.trim();
    if (!text || text.length > MAX_MESSAGE_CHARS) return null;
    messages.push({ from: m.from, text });
  }
  return messages;
}

/**
 * Gemini wants turns to alternate and start with the user. The greeting is the
 * assistant's, so it moves into the system prompt; back-to-back turns from the
 * same side (a retried reply, say) are merged.
 */
function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const role = m.from === "senior" ? "user" : "model";
    if (turns.length === 0 && role === "model") continue;
    const last = turns.at(-1);
    if (last?.role === role) last.text += `\n${m.text}`;
    else turns.push({ role, text: m.text });
  }
  return turns;
}

function chatInstructions(firstName: string, age: number | null): string {
  return `You are KinCare's check-in helper, talking out loud with ${firstName}${age ? `, aged ${age}` : ""}. Their family set this up to hear how ${firstName} is feeling. You opened with: "${greeting(firstName)}"

Rules, all of them strict:
- Your replies are read aloud. One or two short sentences, under 35 words. Everyday words. No lists, headings, emoji or symbols.
- Ask one gentle question at a time. Across the conversation, find out how they feel overall, how they slept, any pain or discomfort, eating and drinking, their mood, and anything they'd like their family to know. Follow what they bring up rather than working through a checklist.
- Briefly reflect back what they said so they know they were heard.
- Never diagnose, never guess at causes, never suggest treatments, medicines or doses, and never say a symptom is fine, normal or nothing to worry about.
- If they mention anything worrying, such as new or worse pain, a fall, dizziness, breathing trouble, confusion, or feeling very low, say you'll make sure their family knows, and suggest they speak to their doctor or call a family member today.
- If they ask a medical question, say it's a good one for their doctor and that you'll pass it on to their family.
- You are not a person and not a doctor. If asked, say you're KinCare's check-in helper.
- Their words come from speech recognition, so expect wrong words, missing words and sentences that stop early. Make your best sensible guess at what they meant and reply to that. Only ask them to repeat themselves if you truly cannot tell what they mean, and never ask twice in a row: ask a simple new question instead.
- After five or six questions, or when they say they're done, thank them warmly and tell them to tap "Finish" to send the note to their family.`;
}

export async function reply(firstName: string, age: number | null, messages: Message[]): Promise<string> {
  const { text } = await converse(chatInstructions(firstName, age), toTurns(messages), { temperature: 0.6 });
  return text;
}

const SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    needs_attention: { type: "BOOLEAN" },
  },
  required: ["summary", "needs_attention"],
};

function summaryInstructions(firstName: string): string {
  return `You write a short note for the family of an older adult, ${firstName}, about a check-in conversation ${firstName} just had with a voice assistant. The family reads it on their phone.

Rules, all of them strict:
- Third person, one paragraph, 80 words or fewer, plain and warm.
- Report only what ${firstName} actually said. Never invent anything, never diagnose, never guess at causes, never reassure that something is fine.
- Lead with anything the family may need to act on: new or worse pain, a fall, dizziness, breathing trouble, confusion, low mood, not eating or drinking, missed medicines, or anything ${firstName} asked the family to know or do.
- Quote ${firstName}'s own words, briefly, for anything important.
- The transcript comes from speech recognition and may contain mistakes. Don't read meaning into odd words.
- If ${firstName} said very little, say so plainly.
- Set needs_attention to true if anything said is something a family member should follow up on today. Otherwise false.`;
}

export async function summarise(
  firstName: string,
  messages: Message[],
): Promise<{ summary: string; needsAttention: boolean; model: string }> {
  const transcript = messages
    .map((m) => `${m.from === "senior" ? firstName : "Assistant"}: ${m.text}`)
    .join("\n");
  const { text, model } = await converse(
    summaryInstructions(firstName),
    [{ role: "user", text: `Transcript:\n${transcript}` }],
    { temperature: 0.3, json: SUMMARY_SCHEMA },
  );

  const parsed = JSON.parse(text) as { summary?: unknown; needs_attention?: unknown };
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  // The table's CHECK allows 1500; a longer note means the model misbehaved.
  if (!summary || summary.length > 1500) throw new Error(`${model} returned an unusable summary`);
  return { summary, needsAttention: parsed.needs_attention === true, model };
}

/**
 * Templated alert from a check-in. Skipped when an unseen check-in alert of
 * the same or higher severity was raised in the last half hour, so one
 * worrying conversation is one alert.
 */
export async function raiseCheckInAlert(
  seniorId: string,
  severity: "critical" | "warning",
  message: string,
): Promise<void> {
  // triggered_value is NOT NULL and means nothing for a spoken check-in; 0
  // keeps the column honest without inventing a reading.
  await pg().query(
    `INSERT INTO alerts (senior_id, alert_kind, severity, triggered_value, message)
     SELECT $1, 'check_in', $2::alert_severity, 0, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM alerts
       WHERE senior_id = $1 AND alert_kind = 'check_in' AND acknowledged_at IS NULL
         AND (severity = 'critical' OR severity = $2::alert_severity)
         AND triggered_at > now() - make_interval(mins => $4)
     )`,
    [seniorId, severity, message, ALERT_DEDUPE_MINUTES],
  );
}

export function urgentAlertMessage(firstName: string, flag: RedFlag): string {
  return `During a check-in, ${firstName} mentioned ${flag.label}. Call ${firstName} now.`;
}

export function followUpAlertMessage(firstName: string): string {
  return `${firstName}'s check-in mentioned something worth following up today. Read the check-in note.`;
}

export async function saveCheckIn(input: {
  seniorId: string;
  startedBy: string;
  startedAt: string;
  seniorTurns: number;
  summary: string;
  needsAttention: boolean;
  model: string;
}): Promise<void> {
  await pg().query(
    `INSERT INTO check_ins (senior_id, started_by, started_at, senior_turns, summary, needs_attention, model)
     VALUES ($1, $2, LEAST($3::timestamptz, now()), $4, $5, $6, $7)`,
    [input.seniorId, input.startedBy, input.startedAt, input.seniorTurns, input.summary, input.needsAttention, input.model],
  );
}

export type CheckInNote = { id: number; endedAt: string; summary: string; needsAttention: boolean };

/** Recent notes, newest first. Empty rather than an error before migration 017 runs. */
export async function listCheckIns(seniorId: string, limit = 5): Promise<CheckInNote[]> {
  try {
    const { rows } = await pg().query<{ id: string; ended_at: Date; summary: string; needs_attention: boolean }>(
      `SELECT id, ended_at, summary, needs_attention FROM check_ins
       WHERE senior_id = $1 ORDER BY ended_at DESC LIMIT $2`,
      [seniorId, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      endedAt: new Date(r.ended_at).toISOString(),
      summary: r.summary,
      needsAttention: r.needs_attention,
    }));
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") {
      console.warn("[check-in] check_ins table missing; run db/migrations/017_check_ins.sql");
      return [];
    }
    throw error;
  }
}
