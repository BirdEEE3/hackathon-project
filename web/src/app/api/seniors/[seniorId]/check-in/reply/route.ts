import { NextResponse } from "next/server";
import { detectRedFlag, emergencyReply, parseMessages, raiseCheckInAlert, reply, urgentAlertMessage } from "@/lib/check-in";
import { getLinkedSenior } from "@/lib/data";
import { ageFrom } from "@/lib/format";
import { getCurrentCaregiver } from "@/lib/session";

// The assistant's next spoken line in a check-in. The client holds the
// conversation and sends all of it each turn; nothing is stored until Finish.
//
// A red-flag phrase short-circuits the model: a fixed reply naming the
// emergency number, and an alert raised now, not when the senior taps Finish
// (they may never tap it).

// Gemini reasons before every reply, and the model list falls through on a
// slow or failing model (12 s each). Without this, a slow turn could be cut
// off by the platform's default function limit and reach the senior as an
// error.
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ seniorId: string }> }) {
  const [{ seniorId }, caregiver] = await Promise.all([params, getCurrentCaregiver()]);

  const senior = await getLinkedSenior(caregiver.id, seniorId);
  if (!senior) {
    // Same response for "does not exist" and "no access", so ids cannot be probed.
    return NextResponse.json({ error: "Senior not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const messages = parseMessages(body?.messages);
  if (!messages || messages.at(-1)?.from !== "senior") {
    return NextResponse.json({ error: "Expected the conversation so far, ending with what the senior said" }, { status: 400 });
  }

  const firstName = senior.full_name.split(" ")[0]!;
  const flag = detectRedFlag(messages.at(-1)!.text);
  if (flag) {
    await raiseCheckInAlert(seniorId, "critical", urgentAlertMessage(firstName, flag));
    return NextResponse.json({ reply: emergencyReply(flag.kind, firstName), emergency: flag.kind });
  }

  try {
    const text = await reply(firstName, ageFrom(senior.date_of_birth), messages);
    return NextResponse.json({ reply: text, emergency: null });
  } catch (error) {
    console.error("[check-in] reply failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "The assistant didn't answer. Try again." }, { status: 503 });
  }
}
