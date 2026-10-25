"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

// The senior's side of a check-in: a banner on their page that opens a
// full-screen voice conversation, then sends a short note to the family.
//
// Speech in and out both use the browser's built-in engines, so there is no
// extra service or key. Where speech recognition isn't available (Firefox),
// the senior types instead; where speech synthesis isn't, they read.

type Message = { from: "senior" | "assistant"; text: string };
type Emergency = "medical" | "self_harm";
type Phase = "speaking" | "listening" | "thinking" | "idle" | "finishing" | "done";

// Minimal shape of the Web Speech API; not every browser ships the types.
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** A clear, unhurried voice if the device has one. */
function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const lang = navigator.language.slice(0, 2);
  const local = voices.filter((v) => v.lang.startsWith(lang));
  return (
    local.find((v) => /natural|neural|enhanced|premium/i.test(v.name)) ??
    local.find((v) => /google|samantha|daniel|karen/i.test(v.name)) ??
    local[0]
  );
}

let chosenVoice: Promise<SpeechSynthesisVoice | null> | null = null;

/**
 * The one voice used for every line, chosen once. Browsers load their voice
 * list asynchronously, so picking per line meant the greeting played in the
 * default voice and every later line in the chosen one. Waits for the list
 * (briefly) and then sticks with the answer, even if it is "the default".
 */
function theVoice(): Promise<SpeechSynthesisVoice | null> {
  chosenVoice ??= new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve(null);
    const pick = () => resolve(pickVoice() ?? null); // later calls are no-ops
    if (synth.getVoices().length > 0) return pick();
    synth.addEventListener("voiceschanged", pick, { once: true });
    setTimeout(pick, 1500);
  });
  return chosenVoice;
}

function utterance(text: string, voice: SpeechSynthesisVoice | null): SpeechSynthesisUtterance {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.92;
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  return u;
}

/**
 * Joins everything heard so far. Android Chrome repeats the whole phrase in
 * each new result instead of only the new words, so a result that starts
 * with what we already have replaces it rather than being appended.
 */
function transcriptOf(results: ArrayLike<ArrayLike<{ transcript: string }>>): string {
  let text = "";
  for (let i = 0; i < results.length; i++) {
    const t = results[i]![0]!.transcript.trim();
    if (!t) continue;
    if (text && t.toLowerCase().startsWith(text.toLowerCase())) text = t;
    else text = text ? `${text} ${t}` : t;
  }
  return text;
}

const STATUS: Record<Phase, string> = {
  speaking: "Speaking…",
  listening: "Listening…",
  thinking: "Thinking…",
  idle: "Tap the circle to talk",
  finishing: "Writing a note for your family…",
  done: "",
};

// Listening is continuous, and the senior's turn ends on our own silence
// timer rather than the browser's. The browser's ends at the first short
// pause, which cut slower speakers off mid-sentence and sent the model half
// a thought.
/** A pause this long, after they've said something, ends their turn. */
const SILENCE_MS = 2200;
/** Nothing at all for this long: stop and let them tap when ready. */
const NOTHING_HEARD_MS = 12_000;
/** Hard cap on one answer. */
const MAX_LISTEN_MS = 60_000;
/** Gap after the assistant stops talking, so the mic doesn't catch its own voice. */
const LISTEN_DELAY_MS = 600;

export function CheckIn({
  seniorId,
  firstName,
  greeting,
}: {
  seniorId: string;
  firstName: string;
  greeting: string;
}) {
  const [open, setOpen] = useState(false);

  // Start loading voices now, so the very first line can use the chosen one.
  useEffect(() => {
    void theVoice();
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-5 rounded-2xl border-2 border-care bg-mist px-5 py-5 text-left hover:bg-surface sm:px-6"
      >
        <span aria-hidden className="relative h-14 w-14 shrink-0">
          <span className="absolute inset-0 rounded-full bg-care opacity-25" />
          <span className="absolute inset-2 rounded-full bg-care" />
        </span>
        <span>
          <span className="block text-2xl font-bold">Talk to KinCare</span>
          <span className="mt-1 block text-lg leading-snug text-ink-soft">
            {firstName}, tap here to tell me how you&apos;re feeling. I&apos;ll pass a short note to your family.
          </span>
        </span>
      </button>
      {open && (
        <Conversation seniorId={seniorId} firstName={firstName} greeting={greeting} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function Conversation({
  seniorId,
  firstName,
  greeting,
  onClose,
}: {
  seniorId: string;
  firstName: string;
  greeting: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([{ from: "assistant", text: greeting }]);
  const [phase, setPhase] = useState<Phase>("speaking");
  const [caption, setCaption] = useState(greeting);
  const [heard, setHeard] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [emergency, setEmergency] = useState<Emergency | null>(null);
  const [typing, setTyping] = useState(() => recognitionClass() === null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [startedAt] = useState(() => new Date().toISOString());

  // Callbacks below are created once and outlive renders, so anything they
  // need to read fresh lives in a ref. Every setMessages also updates this.
  const messagesRef = useRef<Message[]>([{ from: "assistant", text: greeting }]);
  const recognition = useRef<Recognition | null>(null);
  const speechTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hands-free once they've spoken: after each reply, listen again.
  const voiceMode = useRef(recognitionClass() !== null);
  const sent = useRef(false);
  // Bumped on every stop. cancel() fires the utterance's onerror, which must
  // not then run "after speaking" for a line we deliberately cut off.
  const speechGeneration = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const stopAudio = useCallback(() => {
    speechGeneration.current++;
    if (speechTimer.current) clearTimeout(speechTimer.current);
    window.speechSynthesis?.cancel();
    recognition.current?.abort();
    recognition.current = null;
  }, []);

  const listen = useCallback(() => {
    const Rec = recognitionClass();
    if (!Rec) {
      setTyping(true);
      setPhase("idle");
      return;
    }
    stopAudio();
    const rec = new Rec();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    // Interim words included: when the turn ends on our timer, the last
    // phrase is often still interim, and dropping it lost their final words.
    let heardSoFar = "";
    let silence = setTimeout(() => rec.stop(), NOTHING_HEARD_MS);
    const giveUp = setTimeout(() => rec.stop(), MAX_LISTEN_MS);

    rec.onresult = (e) => {
      heardSoFar = transcriptOf(e.results);
      setHeard(heardSoFar);
      clearTimeout(silence);
      silence = setTimeout(() => rec.stop(), SILENCE_MS);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        voiceMode.current = false;
        setTyping(true);
        setNotice("The microphone is turned off for this site, so let's type instead.");
      }
    };
    rec.onend = () => {
      clearTimeout(silence);
      clearTimeout(giveUp);
      if (recognition.current !== rec) return; // superseded or cancelled
      recognition.current = null;
      const text = heardSoFar.trim();
      if (text) {
        void send(text);
      } else {
        setPhase("idle");
        setNotice((n) => n ?? "I didn't hear anything. Tap the circle when you're ready.");
      }
    };

    recognition.current = rec;
    setHeard("");
    setNotice(null);
    setPhase("listening");
    rec.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send is stable enough; it reads refs
  }, [stopAudio]);

  /** Audio only; the caller sets the caption and phase. */
  const voice = useCallback(
    (text: string, after: () => void) => {
      stopAudio();
      // Some browsers never fire onend for long text, so a timer backs it up.
      const estimate = text.split(/\s+/).length * 420 + 1500;
      const generation = speechGeneration.current;
      let finished = false;
      const done = () => {
        if (finished || generation !== speechGeneration.current) return;
        finished = true;
        if (speechTimer.current) clearTimeout(speechTimer.current);
        after();
      };
      speechTimer.current = setTimeout(done, window.speechSynthesis ? estimate + 4000 : estimate);
      if (!window.speechSynthesis) return;
      void theVoice().then((v) => {
        if (generation !== speechGeneration.current) return; // stopped while voices loaded
        const u = utterance(text, v);
        u.onend = done;
        u.onerror = done;
        window.speechSynthesis.speak(u);
      });
    },
    [stopAudio],
  );

  const speak = useCallback(
    (text: string, after: () => void) => {
      setCaption(text);
      setPhase("speaking");
      voice(text, after);
    },
    [voice],
  );

  const afterSpeaking = useCallback(() => {
    if (!voiceMode.current) {
      setPhase("idle");
      return;
    }
    // Short gap first: the speaker's tail end, or its echo in the room, was
    // being transcribed as the senior's answer.
    const generation = speechGeneration.current;
    setTimeout(() => {
      if (generation === speechGeneration.current && voiceMode.current) listen();
    }, LISTEN_DELAY_MS);
  }, [listen]);

  async function send(text: string) {
    const next: Message[] = [...messagesRef.current, { from: "senior", text }];
    setMessages(next);
    messagesRef.current = next;
    setHeard("");
    setPhase("thinking");

    // One quiet retry for a server-side failure (a busy model, a cold
    // start) before telling the senior anything.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`/api/seniors/${seniorId}/check-in/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: next }),
          signal: AbortSignal.timeout(45_000),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || typeof body?.reply !== "string") {
          console.warn(`[check-in] reply failed (${res.status}):`, body?.error ?? "no body");
          if (res.status >= 500 && attempt === 1) continue;
          break;
        }
        const withReply: Message[] = [...next, { from: "assistant", text: body.reply }];
        setMessages(withReply);
        messagesRef.current = withReply;
        if (body.emergency) setEmergency(body.emergency);
        speak(body.reply, afterSpeaking);
        return;
      } catch (error) {
        console.warn("[check-in] reply failed:", error);
        if (attempt === 1) continue;
      }
    }

    // Not added to the conversation: the model never said it. Says the
    // fault is ours, because it is; "I didn't catch that" blamed the senior's
    // speech for a server problem.
    speak("Sorry, I lost my train of thought for a moment. Could you tell me that once more?", afterSpeaking);
  }

  async function finish() {
    stopAudio();
    setPhase("finishing");
    setNotice(null);
    try {
      const res = await fetch(`/api/seniors/${seniorId}/check-in/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: messagesRef.current, startedAt }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Couldn't send");
      sent.current = true;
      setNote(body.summary);
      setPhase("done");
      // Spoken directly rather than through speak(), which would flip the
      // screen back to the orb while it talks.
      if (window.speechSynthesis) {
        const line = `Thank you, ${firstName}. I've sent a note to your family.`;
        void theVoice().then((v) => window.speechSynthesis.speak(utterance(line, v)));
      }
      router.refresh();
    } catch (error) {
      setPhase("idle");
      setNotice(error instanceof Error ? error.message : "Couldn't send the note. Try Finish again.");
    }
  }

  function close() {
    const spoke = messagesRef.current.some((m) => m.from === "senior");
    if (spoke && !sent.current && !window.confirm("Close without sending a note to your family?")) return;
    stopAudio();
    onClose();
  }

  function onOrb() {
    if (phase === "listening") recognition.current?.stop();
    else if (phase === "speaking" || phase === "idle") {
      voiceMode.current = true;
      setTyping(false);
      listen();
    }
  }

  // Open with the greeting. The tap that opened this counts as the user
  // gesture browsers require before speaking.
  // The first render already shows the greeting in the speaking state.
  useEffect(() => {
    voice(greeting, afterSpeaking);
    return stopAudio;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  // Full-screen: no page scroll behind it, Escape closes, focus starts inside.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close reads refs
  }, []);

  const seniorTurns = messages.filter((m) => m.from === "senior").length;
  const busy = phase === "thinking" || phase === "finishing";
  const full = messages.length >= 58;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="check-in-title"
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-paper"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-6 pt-5">
        <div className="flex items-center justify-between">
          <h2 id="check-in-title" className="text-xl font-bold">
            Check-in with {firstName}
          </h2>
          <button
            type="button"
            onClick={close}
            className="rounded-full border-2 border-line px-4 py-1.5 font-bold hover:border-care"
          >
            Close
          </button>
        </div>

        {emergency && (
          <div role="alert" className="mt-5 rounded-2xl border-2 border-rose bg-rose-tint px-5 py-4">
            <p className="text-lg font-bold">
              {emergency === "self_harm" ? "You don't have to go through this alone." : "This may need help right away."}
            </p>
            <p className="mt-1 text-lg">Your family has been sent an alert.</p>
            {/*
              Demo build: deliberately no tel: links, so nothing here can dial
              emergency services. A real deployment would put "Call 911" (and
              "Call or text 988" for self-harm) buttons back here.
            */}
            <p className="mt-3 text-lg">
              In a real emergency, call {emergency === "self_harm" ? "or text 988, or call 911" : "911"}.
            </p>
            <p className="mt-1 text-sm text-ink-soft">This is a demo, so calling from KinCare is turned off.</p>
          </div>
        )}

        {phase === "done" && note ? (
          <div className="mt-10 flex flex-1 flex-col">
            <p className="text-3xl font-bold leading-tight">Thank you, {firstName}.</p>
            <p className="mt-3 text-xl text-ink-soft">This is the note your family will see:</p>
            <blockquote className="mt-5 rounded-2xl border-2 border-line bg-surface px-5 py-5 text-xl leading-relaxed">
              {note}
            </blockquote>
            <button
              type="button"
              onClick={() => {
                stopAudio();
                onClose();
              }}
              className="mt-8 self-start rounded-full bg-care px-8 py-4 text-xl font-bold text-on-care hover:bg-care-strong"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-1 flex-col items-center justify-center gap-5 py-6">
              <button
                type="button"
                onClick={onOrb}
                disabled={busy}
                aria-label={phase === "listening" ? "Stop listening" : "Tap to talk"}
                className="orb rounded-full disabled:cursor-wait"
                data-state={phase === "finishing" ? "thinking" : phase}
              >
                <span className="orb-ring" style={{ "--speed": "0.9s", "--to": 1.18 } as React.CSSProperties} />
                <span className="orb-ring" style={{ "--speed": "1.3s", "--to": 1.3 } as React.CSSProperties} />
                <span className="orb-ring" style={{ "--speed": "1.7s", "--to": 1.42 } as React.CSSProperties} />
                <span className="orb-core" />
              </button>
              <p aria-live="polite" className="text-lg font-bold text-care-strong">
                {STATUS[phase]}
              </p>
              <p aria-live="polite" className="min-h-[5rem] max-w-xl text-center text-2xl leading-snug">
                {phase === "listening" && heard ? <span className="text-ink-soft">{heard}</span> : caption}
              </p>
              {notice && <p className="max-w-xl text-center text-lg text-marigold">{notice}</p>}
            </div>

            {typing && (
              <form
                className="flex gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = draft.trim();
                  if (!text || busy || full) return;
                  setDraft("");
                  voiceMode.current = false;
                  setNotice(null);
                  void send(text);
                }}
              >
                <label htmlFor="check-in-text" className="sr-only">
                  Type your answer
                </label>
                <input
                  id="check-in-text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={1000}
                  autoComplete="off"
                  placeholder="Type your answer"
                  className="min-w-0 flex-1 rounded-full border-2 border-line bg-surface px-5 py-3 text-lg focus:border-care"
                />
                <button
                  type="submit"
                  disabled={busy || full || !draft.trim()}
                  className="rounded-full bg-care px-6 py-3 text-lg font-bold text-on-care disabled:opacity-50"
                >
                  Send
                </button>
              </form>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              {recognitionClass() ? (
                <button
                  type="button"
                  onClick={() => {
                    const next = !typing;
                    setTyping(next);
                    voiceMode.current = !next;
                    if (next) {
                      stopAudio();
                      setPhase("idle");
                    }
                  }}
                  className="rounded-full px-4 py-2 text-lg font-bold text-care-strong underline underline-offset-4"
                >
                  {typing ? "Talk instead" : "Type instead"}
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={finish}
                disabled={busy || seniorTurns === 0}
                className="rounded-full bg-care px-8 py-4 text-xl font-bold text-on-care hover:bg-care-strong disabled:opacity-50"
              >
                Finish
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
