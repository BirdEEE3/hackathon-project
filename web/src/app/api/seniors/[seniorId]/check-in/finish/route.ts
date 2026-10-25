import { NextResponse } from "next/server";
import {
  detectRedFlag,
  followUpAlertMessage,
  parseMessages,
  raiseCheckInAlert,
  saveCheckIn,
  summarise,
  urgentAlertMessage,
} from "@/lib/check-in";
import { getLinkedSenior } from "@/lib/data";
import { getCurrentCaregiver } from "@/lib/session";

// Ends a check-in: Gemini turns the conversation into a note for the family,
// the note is stored, and the transcript is dropped.

// See reply/route.ts: the same model calls, the same reason.
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ seniorId: string }> }) {
  const [{ seniorId }, caregiver] = await Promise.all([params, getCurrentCaregiver()]);

  const senior = await getLinkedSenior(caregiver.id, seniorId);
  if (!senior) {
    return NextResponse.json({ error: "Senior not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const messages = parseMessages(body?.messages);
  const startedAt = typeof body?.startedAt === "string" && !Number.isNaN(Date.parse(body.startedAt)) ? body.startedAt : null;
  const seniorTurns = messages?.filter((m) => m.from === "senior").length ?? 0;
  if (!messages || !startedAt || seniorTurns === 0) {
    return NextResponse.json({ error: "Nothing to summarise yet" }, { status: 400 });
  }

  const firstName = senior.full_name.split(" ")[0]!;

  // Re-check the whole conversation. Normally the reply route already raised
  // this alert and the dedupe skips it; this catches a red flag in a message
  // whose reply never came back.
  const flag = messages
    .filter((m) => m.from === "senior")
    .map((m) => detectRedFlag(m.text))
    .find((f) => f !== null);
  if (flag) await raiseCheckInAlert(seniorId, "critical", urgentAlertMessage(firstName, flag));

  let note: Awaited<ReturnType<typeof summarise>>;
  try {
    note = await summarise(firstName, messages);
  } catch (error) {
    console.error("[check-in] summary failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Couldn't write the note. Try Finish again." }, { status: 503 });
  }

  const needsAttention = note.needsAttention || flag !== undefined;
  await saveCheckIn({
    seniorId,
    startedBy: caregiver.id,
    startedAt,
    seniorTurns,
    summary: note.summary,
    needsAttention,
    model: note.model,
  });
  if (note.needsAttention && !flag) {
    await raiseCheckInAlert(seniorId, "warning", followUpAlertMessage(firstName));
  }

  return NextResponse.json({ summary: note.summary, needsAttention }, { status: 201 });
}
