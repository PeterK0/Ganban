import { useEffect, useRef, useState } from "react";
import { NATO_WORDS } from "./natoWords";

type Difficulty = keyof typeof NATO_WORDS;
type Mode = "comprehension" | "production";
type Phase = "picking" | "playing" | "results";
type Grade = "A" | "B" | "C" | "F";

const NATO: Record<string, string> = {
  A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot",
  G: "Golf", H: "Hotel", I: "India", J: "Juliett", K: "Kilo", L: "Lima",
  M: "Mike", N: "November", O: "Oscar", P: "Papa", Q: "Quebec", R: "Romeo",
  S: "Sierra", T: "Tango", U: "Uniform", V: "Victor", W: "Whiskey",
  X: "X-ray", Y: "Yankee", Z: "Zulu",
};

const PANGRAMS = [
  "THE QUICK BROWN FOX",
  "JUMPS OVER THE LAZY DOG",
  "PACK MY BOX WITH FIVE DOZEN LIQUOR JUGS",
  "HOW VEXINGLY QUICK DAFT ZEBRAS JUMP",
];
const SENTENCE_CHANCE = 0.1;

const DIFFICULTIES: { id: Difficulty; hint: string }[] = [
  { id: "easy", hint: "≤5 letters" },
  { id: "medium", hint: "6–9 letters" },
  { id: "hard", hint: "10–15 letters" },
  { id: "impossible", hint: ">15 letters" },
];

// expected_time = letters * factor + 4 seconds, from the original game.
const EXPECTED_FACTOR: Record<Difficulty, number> = { easy: 3, medium: 2.5, hard: 2, impossible: 1.5 };
const SPEECH_RATE: Record<Difficulty, number> = { easy: 0.85, medium: 1.0, hard: 1.15, impossible: 1.3 };

const GRADE_COLOR: Record<Grade, string> = {
  A: "text-success",
  B: "text-primary",
  C: "text-subtext-1",
  F: "text-error",
};

const speechOk =
  typeof window !== "undefined" &&
  "speechSynthesis" in window &&
  typeof SpeechSynthesisUtterance !== "undefined";

/** Letters only — word gaps in sentence challenges add no tokens. */
function natoSpell(text: string): string[] {
  const out: string[] = [];
  for (const ch of text.toUpperCase()) {
    const w = NATO[ch];
    if (w) out.push(w);
  }
  return out;
}

const normalizeToken = (t: string) => t.toLowerCase();

/**
 * Alternate spellings that are fully correct: ICAO's own variants (Alfa,
 * Juliett) plus phonetically identical forms. The trainer tests whether you
 * know the word, not one canonical orthography.
 */
const ALIASES: Record<string, string[]> = {
  alpha: ["alfa"],
  juliett: ["juliet", "juliette"],
  whiskey: ["whisky"],
  "x-ray": ["xray"],
  oscar: ["oskar"],
};

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2; // callers only care about ≤1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

type TokenMatch = "exact" | "typo" | "wrong";

/**
 * Production tokens are NATO words: aliases pass outright, and a one-letter
 * slip ("siera") passes with a note — no two NATO words are close enough for
 * that to ever accept the wrong word.
 */
function matchNatoToken(expected: string, got: string): TokenMatch {
  const e = normalizeToken(expected);
  const g = normalizeToken(got);
  const accepted = [e, ...(ALIASES[e] ?? [])];
  if (accepted.includes(g)) return "exact";
  if (accepted.some((c) => editDistance(c, g) <= 1)) return "typo";
  return "wrong";
}

interface Mistake {
  position: number;
  expected: string | null; // null → extra word from the player
  got: string | null; // null → missing word
}

interface AcceptedTypo {
  position: number;
  expected: string;
  got: string;
}

interface Comparison {
  mistakes: Mistake[];
  accepted: AcceptedTypo[];
}

/**
 * Word-by-word, case-insensitive after whitespace normalization. Lenient
 * grading (production) forgives variant spellings and one-letter typos;
 * comprehension stays exact — there a one-letter difference IS a decoding
 * mistake (Bravo Alpha Tango heard as "bad" must not pass as "bat").
 */
function compareAnswers(expected: string[], answerRaw: string, lenient: boolean): Comparison {
  const got = answerRaw.trim().split(/\s+/).filter(Boolean);
  const mistakes: Mistake[] = [];
  const accepted: AcceptedTypo[] = [];
  for (let i = 0; i < Math.max(expected.length, got.length); i++) {
    const e = expected[i] ?? null;
    const g = got[i] ?? null;
    if (lenient && e !== null && g !== null) {
      const m = matchNatoToken(e, g);
      if (m === "typo") accepted.push({ position: i + 1, expected: e, got: g });
      if (m === "wrong") mistakes.push({ position: i + 1, expected: e, got: g });
      continue;
    }
    if ((e === null ? null : normalizeToken(e)) !== (g === null ? null : normalizeToken(g))) {
      mistakes.push({ position: i + 1, expected: e, got: g });
    }
  }
  return { mistakes, accepted };
}

function computeGrade(mistakeCount: number, repeatUsed: boolean, elapsed: number, expected: number): Grade {
  if (mistakeCount > 0) return "F";
  if (repeatUsed) return "C";
  if (elapsed <= expected) return "A";
  if (elapsed <= 1.5 * expected) return "B";
  if (elapsed <= 2 * expected) return "C";
  return "F";
}

interface Round {
  challenge: string; // hidden word (comprehension) or shown text (production)
  expected: string[]; // tokens the answer is graded against
  expectedSeconds: number;
  isSentence: boolean;
  rate: number;
}

function makeRound(mode: Mode, difficulty: Difficulty): Round {
  const factor = EXPECTED_FACTOR[difficulty];
  const rate = SPEECH_RATE[difficulty];
  if (mode === "production" && Math.random() < SENTENCE_CHANCE) {
    const s = PANGRAMS[Math.floor(Math.random() * PANGRAMS.length)];
    const expected = natoSpell(s);
    return { challenge: s, expected, expectedSeconds: expected.length * factor + 4, isSentence: true, rate };
  }
  const pool = NATO_WORDS[difficulty];
  const word = pool[Math.floor(Math.random() * pool.length)];
  const letters = natoSpell(word).length;
  return {
    challenge: word,
    expected: mode === "production" ? natoSpell(word) : [word],
    expectedSeconds: letters * factor + 4,
    isSentence: false,
    rate,
  };
}

interface RoundResult {
  round: Round;
  mode: Mode;
  answer: string;
  elapsed: number;
  mistakes: Mistake[];
  accepted: AcceptedTypo[];
  grade: Grade;
  repeatUsed: boolean;
}

interface Tally {
  rounds: number;
  grades: Record<Grade, number>;
}

/**
 * The NATO trainer: a faithful remake of the original CLI game. Comprehension
 * speaks a word's phonetic spelling and you decode it; production shows a word
 * (occasionally a pangram sentence) and you type its full NATO spelling.
 * UI-only — nothing touches the host.
 */
export default function NatoTab({ projectId }: { projectId: number }) {
  void projectId;
  const [phase, setPhase] = useState<Phase>("picking");
  const [mode, setMode] = useState<Mode>("comprehension");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [round, setRound] = useState<Round | null>(null);
  const [answer, setAnswer] = useState("");
  const [repeatUsed, setRepeatUsed] = useState(false);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [tally, setTally] = useState<Tally>({ rounds: 0, grades: { A: 0, B: 0, C: 0, F: 0 } });
  const startedAt = useRef<number | null>(null);

  useEffect(() => () => {
    if (speechOk) window.speechSynthesis.cancel();
  }, []);

  const speakRound = (r: Round, firstPlay: boolean) => {
    if (!speechOk) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(natoSpell(r.challenge).join(" "));
    u.rate = r.rate;
    // The clock starts when audio actually starts; the presentation-time
    // timestamp set in beginRound is only the fallback if onstart never fires.
    if (firstPlay) u.onstart = () => { startedAt.current = performance.now(); };
    window.speechSynthesis.speak(u);
  };

  const beginRound = (m: Mode, d: Difficulty) => {
    if (speechOk) window.speechSynthesis.cancel();
    const r = makeRound(m, d);
    setRound(r);
    setAnswer("");
    setRepeatUsed(false);
    setResult(null);
    setPhase("playing");
    startedAt.current = performance.now();
    if (m === "comprehension") speakRound(r, true);
  };

  const repeat = () => {
    if (!round) return;
    setRepeatUsed(true);
    speakRound(round, false);
  };

  const submit = () => {
    if (!round) return;
    if (speechOk) window.speechSynthesis.cancel();
    const elapsed = (performance.now() - (startedAt.current ?? performance.now())) / 1000;
    const { mistakes, accepted } = compareAnswers(round.expected, answer, mode === "production");
    const grade = computeGrade(mistakes.length, repeatUsed, elapsed, round.expectedSeconds);
    setResult({ round, mode, answer, elapsed, mistakes, accepted, grade, repeatUsed });
    setTally((t) => ({ rounds: t.rounds + 1, grades: { ...t.grades, [grade]: t.grades[grade] + 1 } }));
    setPhase("results");
  };

  const quit = () => {
    if (speechOk) window.speechSynthesis.cancel();
    setRound(null);
    setPhase("picking");
  };

  return (
    <div className="flex-1 overflow-y-auto bg-base text-text">
      <div className="px-8 py-8 space-y-6">
        {phase === "picking" && (
          <>
            <div>
              <h1 className="g-ptitle">NATO Trainer</h1>
              <p className="text-sm text-subtext-0 mt-2">
                Alpha to Zulu, against the clock. Pick a mode and a difficulty.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-3">
              {(
                [
                  { id: "comprehension", title: "Comprehension", blurb: "Hear a phonetic spelling, type the hidden word." },
                  { id: "production", title: "Production", blurb: "See a word, type its full NATO spelling." },
                ] as { id: Mode; title: string; blurb: string }[]
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`g-card text-left p-5 transition-colors ${
                    mode === m.id ? "!border-gold !bg-gilt-b" : "hover:!bg-surface-0"
                  }`}
                >
                  <div className={`font-semibold ${mode === m.id ? "text-gold" : "text-text"}`}>{m.title}</div>
                  <div className="text-xs text-subtext-0 mt-1">{m.blurb}</div>
                </button>
              ))}
            </div>

            <div>
              <div className="g-h2">Difficulty</div>
              <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setDifficulty(d.id)}
                    className={`px-3 py-2 rounded border text-sm transition-colors ${
                      difficulty === d.id
                        ? "border-gilt-a bg-gilt-b text-gold"
                        : "border-surface-0 bg-base text-text hover:bg-surface-0"
                    }`}
                  >
                    <span className="capitalize">{d.id}</span>
                    <span className="block text-xs text-subtext-0">{d.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => beginRound(mode, difficulty)}
              className="g-btn g-btn-pri w-full"
            >
              Start round
            </button>

            <div>
              <div className="g-h2">Reference</div>
              <div className="grid grid-cols-3 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
                {Object.entries(NATO).map(([letter, word]) => (
                  <div key={letter} className="px-2 py-1 border-b border-gilt-b text-xs">
                    <span className="font-deco font-semibold text-gold">{letter}</span>
                    <span className="text-subtext-1 ml-1.5">{word}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {phase === "playing" && round && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <div className="text-sm text-subtext-0">
                <span className="font-medium text-text capitalize">{mode}</span>
                {" · "}
                <span className="capitalize">{difficulty}</span>
                {round.isSentence && " · sentence challenge"}
              </div>
              <button onClick={quit} className="g-btn g-btn-sm g-btn-ghost">
                Quit
              </button>
            </div>

            <div className="g-card g-corners p-7 space-y-4">
              {mode === "comprehension" ? (
                speechOk ? (
                  <>
                    <p className="text-sm text-text">Listen to the phonetic spelling and type the word it spells.</p>
                    <button
                      onClick={repeat}
                      className="g-btn g-btn-sm g-btn-ghost"
                    >
                      Repeat audio
                    </button>
                    <p className="text-xs text-subtext-0">Repeating caps your grade at C.</p>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-subtext-0">
                      Speech synthesis isn't available here — read the phonetics instead.
                    </p>
                    <p className="text-lg font-medium tracking-wide">{natoSpell(round.challenge).join(" ")}</p>
                    <p className="text-sm text-subtext-1">Type the word it spells.</p>
                  </>
                )
              ) : (
                <>
                  <p className={`font-semibold ${round.isSentence ? "text-xl tracking-widest" : "text-3xl tracking-widest"}`}>
                    {round.challenge}
                  </p>
                  <p className="text-sm text-subtext-1">
                    Type the full NATO spelling, one phonetic word per letter (e.g. WORD → Whiskey Oscar Romeo Delta).
                  </p>
                  <p className="text-xs text-subtext-0">Voice input is on the roadmap — type for now.</p>
                </>
              )}
            </div>

            <div className="flex gap-2">
              <input
                autoFocus
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                placeholder={mode === "comprehension" ? "The decoded word…" : "Alpha Bravo Charlie…"}
                className="g-field flex-1 !w-auto min-w-0"
              />
              <button onClick={submit} className="g-btn g-btn-pri">
                Submit
              </button>
            </div>
            <p className="text-xs text-subtext-0">The clock is running — Enter submits.</p>
          </div>
        )}

        {phase === "results" && result && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="g-card g-corners p-7 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="g-cap">
                    <span className="capitalize">{result.mode}</span> · <span className="capitalize">{difficulty}</span>
                    {result.round.isSentence && " · sentence"}
                  </div>
                  <div className="text-sm text-subtext-1 mt-1">
                    {result.mistakes.length === 0 ? "Clean answer" : `${result.mistakes.length} mistake${result.mistakes.length === 1 ? "" : "s"}`}
                    {result.accepted.length > 0 &&
                      ` · ${result.accepted.length} typo${result.accepted.length === 1 ? "" : "s"} forgiven`}
                    {result.repeatUsed && " · repeat used"}
                  </div>
                </div>
                <div className={`font-deco text-6xl font-light ${GRADE_COLOR[result.grade]}`}>{result.grade}</div>
              </div>

              <div className="space-y-2 text-sm">
                {result.mode === "comprehension" && (
                  <div className="flex gap-2">
                    <span className="w-28 shrink-0 text-subtext-0">Phonetics</span>
                    <span className="text-subtext-1">{natoSpell(result.round.challenge).join(" ")}</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <span className="w-28 shrink-0 text-subtext-0">Correct answer</span>
                  <span className="text-text">{result.round.expected.join(" ")}</span>
                </div>
                <div className="flex gap-2">
                  <span className="w-28 shrink-0 text-subtext-0">Your answer</span>
                  <span className={result.mistakes.length === 0 ? "text-success" : "text-error"}>
                    {result.answer.trim() || "—"}
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="w-28 shrink-0 text-subtext-0">Time</span>
                  <span className="text-text">
                    {result.elapsed.toFixed(1)}s
                    <span className="text-subtext-0"> (expected {result.round.expectedSeconds.toFixed(1)}s)</span>
                  </span>
                </div>
              </div>

              {result.mistakes.length > 0 && (
                <div>
                  <div className="g-cap mb-1.5">Mistakes</div>
                  <ul className="space-y-0.5 text-sm">
                    {result.mistakes.map((m) => (
                      <li key={m.position} className="text-subtext-1">
                        <span className="text-subtext-0">word {m.position}:</span>{" "}
                        {m.expected === null
                          ? <>extra <span className="text-error">{m.got}</span></>
                          : m.got === null
                            ? <>missing <span className="text-text">{m.expected}</span></>
                            : <>expected <span className="text-text">{m.expected}</span>, got <span className="text-error">{m.got}</span></>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.accepted.length > 0 && (
                <div>
                  <div className="g-cap mb-1.5">
                    Accepted with a typo
                  </div>
                  <ul className="space-y-0.5 text-sm">
                    {result.accepted.map((m) => (
                      <li key={m.position} className="text-subtext-1">
                        <span className="text-subtext-0">word {m.position}:</span>{" "}
                        <span className="text-warning">{m.got}</span> counted as{" "}
                        <span className="text-text">{m.expected}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="g-plain px-4 py-3 flex flex-wrap items-center gap-4 text-sm">
              <span className="text-subtext-0">
                Session: {tally.rounds} round{tally.rounds === 1 ? "" : "s"}
              </span>
              {(["A", "B", "C", "F"] as Grade[]).map((g) => (
                <span key={g} className="text-subtext-1">
                  <span className={`font-semibold ${GRADE_COLOR[g]}`}>{g}</span> ×{tally.grades[g]}
                </span>
              ))}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => beginRound(mode, difficulty)}
                className="g-btn g-btn-pri flex-1"
              >
                Play again
              </button>
              <button
                onClick={quit}
                className="g-btn g-btn-ghost"
              >
                Change mode / difficulty
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
