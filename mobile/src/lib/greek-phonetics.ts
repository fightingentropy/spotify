// Modern Greek → English-reader phonetic transliteration.
//
// Aimed at someone who reads the Latin alphabet but not Greek and wants to sing
// along: it favours how a word SOUNDS to an English ear over strict academic
// transliteration (so χ→h, ου→oo, μπ→b, ευ→ev/ef …). The Greek stress accent is
// carried through to the Latin vowel (ά→á, ή→í …) so the reader knows which
// syllable to hit. Pure + synchronous + offline — runs per lyric line.
//
// It is deliberately rule-based rather than a lookup table: that makes it work
// for *every* Greek song automatically, with no per-track data to fetch or store.

// Greek + Greek-Extended (polytonic) ranges.
const GREEK_RE = /[Ͱ-Ͽἀ-῿]/;
// A maximal run of Greek letters (one word). Accents live inside the range, so a
// run stays whole; spaces / punctuation / apostrophes split words apart.
const GREEK_RUN_RE = /[Ͱ-Ͽἀ-῿]+/g;

// True when the text contains any Greek letter — i.e. worth a phonetic line.
export function hasGreek(text: string): boolean {
  return GREEK_RE.test(text);
}

// Voiceless consonants: αυ/ευ devoice to af/ef before these (or at word end).
const VOICELESS = new Set(["θ", "κ", "ξ", "π", "σ", "ς", "τ", "φ", "χ", "ψ"]);
// Front vowels: γ becomes a "y" glide before them (γε→ye, γι→yi …).
const FRONT = new Set(["ε", "έ", "ι", "ί", "η", "ή", "υ", "ύ", "ϊ", "ϋ", "ΐ", "ΰ"]);

const SINGLE: Record<string, string> = {
  α: "a", ά: "á", ε: "e", έ: "é", η: "i", ή: "í",
  ι: "i", ί: "í", ϊ: "i", ΐ: "í", ο: "o", ό: "ó",
  υ: "i", ύ: "í", ϋ: "i", ΰ: "í", ω: "o", ώ: "ó",
  β: "v", δ: "dh", ζ: "z", θ: "th", κ: "k", λ: "l",
  μ: "m", ν: "n", ξ: "ks", π: "p", ρ: "r", σ: "s",
  ς: "s", τ: "t", φ: "f", χ: "h", ψ: "ps",
};

// Transliterate one lowercased Greek word (no spaces/punctuation inside).
function translitWord(w: string): string {
  let out = "";
  const n = w.length;
  for (let i = 0; i < n; ) {
    const c = w[i];
    const c2 = w[i + 1];
    const atStart = i === 0;

    // --- consonant digraphs (must precede the single-letter rules) ---
    if (c === "μ" && c2 === "π") { out += atStart ? "b" : "mb"; i += 2; continue; }
    if (c === "ν" && c2 === "τ") { out += atStart ? "d" : "nd"; i += 2; continue; }
    if (c === "γ" && c2 === "κ") { out += atStart ? "g" : "ng"; i += 2; continue; }
    if (c === "γ" && c2 === "γ") { out += "ng"; i += 2; continue; }
    if (c === "γ" && c2 === "χ") { out += "nh"; i += 2; continue; }
    if (c === "τ" && c2 === "σ") { out += "ts"; i += 2; continue; }
    if (c === "τ" && c2 === "ζ") { out += "dz"; i += 2; continue; }

    // --- vowel diphthongs: only when the first vowel is PLAIN (unaccented). An
    // accent on the first vowel (ό-ι in ρολόι) or a dialytika on the second
    // (Μά-ι-ος) breaks the pair into two separate vowels — handled by falling
    // through to SINGLE. The accent may sit on the second vowel (αί, εύ …). ---
    if (c === "ο" && (c2 === "υ" || c2 === "ύ")) { out += "oo"; i += 2; continue; }
    if (c === "α" && (c2 === "ι" || c2 === "ί")) { out += c2 === "ί" ? "é" : "e"; i += 2; continue; }
    if (c === "ε" && (c2 === "ι" || c2 === "ί")) { out += c2 === "ί" ? "í" : "i"; i += 2; continue; }
    if (c === "ο" && (c2 === "ι" || c2 === "ί")) { out += c2 === "ί" ? "í" : "i"; i += 2; continue; }
    if ((c === "α" || c === "ε") && (c2 === "υ" || c2 === "ύ")) {
      const next = w[i + 2];
      const devoice = next === undefined || VOICELESS.has(next);
      const stressed = c2 === "ύ";
      const v = c === "α" ? "a" : "e";
      const head = stressed ? (v === "a" ? "á" : "é") : v;
      out += head + (devoice ? "f" : "v");
      i += 2;
      continue;
    }

    // --- γ glide: "y" before a front vowel, otherwise a hard "g" ---
    if (c === "γ") { out += c2 !== undefined && FRONT.has(c2) ? "y" : "g"; i += 1; continue; }

    out += SINGLE[c] ?? c;
    i += 1;
  }
  return out;
}

// Re-apply the source word's capitalization to the transliterated word.
function applyCase(src: string, out: string): string {
  if (src.length > 1 && src === src.toUpperCase() && src !== src.toLowerCase()) {
    return out.toUpperCase();
  }
  if (src[0] !== src[0]?.toLowerCase()) {
    return out.charAt(0).toUpperCase() + out.slice(1);
  }
  return out;
}

// Lyrics re-render on every progress tick while a line is highlighted; cache the
// (cheap, but repeated) per-line result so scrolling stays smooth.
const cache = new Map<string, string>();
const CACHE_MAX = 2000;

// Phonetic Latin spelling of a lyric line. Non-Greek runs (Latin words, digits,
// punctuation) pass through untouched, so mixed-language lines read naturally.
export function transliterateGreek(line: string): string {
  const hit = cache.get(line);
  if (hit !== undefined) return hit;
  const result = line.replace(GREEK_RUN_RE, (run) => applyCase(run, translitWord(run.toLowerCase())));
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(line, result);
  return result;
}
