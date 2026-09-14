"""Builds the compact word lists used by the games (data/en.js, data/hu.js).

Usage:  python tools/build_words.py

The raw source lists are downloaded into tools/raw/ on the first run.
"""

import os
import random
import urllib.request
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "tools", "raw")
OUT = os.path.join(ROOT, "data")

SOURCES = {
    "enable1.txt": "https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt",
    "en_50k.txt": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt",
    "hu_50k.txt": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/hu/hu_50k.txt",
    "hu_HU.dic": "https://raw.githubusercontent.com/LibreOffice/dictionaries/master/hu_HU/hu_HU.dic",
}

EN_ALPHABET = set("abcdefghijklmnopqrstuvwxyz")
HU_ALPHABET = set("aábcdeéfghiíjklmnoóöőpqrstuúüűvwxyz")

# Words that should never be a daily answer (they stay valid as Wordle guesses).
EN_BLOCK_PREFIX = ("fuck", "shit", "cunt", "bitch", "whore", "slut", "nigg", "fagg", "pussy",
                   "dildo", "porn", "rapist", "wank", "twat", "cock", "boob", "penis", "vagin")
EN_BLOCK = {"fag", "fags", "rape", "raped", "rapes", "tits", "titty", "dick", "dicks", "anal",
            "anus", "semen", "sperm", "horny", "piss", "pissed", "crap", "damn", "bastard", "slave",
            "nazi", "nazis", "kill", "killed", "dead", "death", "homo", "dyke", "gook", "spic",
            "kike", "retard", "sexy", "sex", "sexes", "orgy", "prick", "screw", "booze", "drunk",
            "negro", "coon", "hooker", "pimp", "scum", "turd", "butt", "arse", "arses", "bong",
            "fanny", "wussy", "fecal", "pilar", "hotch", "cline", "lamia", "gonna", "wanna",
            "maria", "nancy", "texas", "batman", "anna", "miri", "cooch", "cholo"}
HU_BLOCK_PREFIX = ("kurv", "fasz", "basz", "bazd", "pics", "pina", "gec", "buzi", "köcsög", "ribanc",
                   "szop", "segg", "kúr", "húgy", "hugy", "fing", "cigány", "zsidó", "néger", "csicska")
HU_BLOCK = {"szar", "szart", "szaros", "lófasz", "halál", "hulla", "ölés", "gyilkos", "náci",
            "haha", "hahaha", "hehe", "team", "okay"}


def download():
    os.makedirs(RAW, exist_ok=True)
    for name, url in SOURCES.items():
        path = os.path.join(RAW, name)
        if not os.path.exists(path):
            print("letöltés:", url)
            urllib.request.urlretrieve(url, path)


def read_lines(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        return [line.rstrip("\n") for line in f]


def read_freq(name, alphabet):
    """word -> rank (0 = most frequent)"""
    rank = {}
    for line in read_lines(name):
        parts = line.split(" ")
        if len(parts) != 2:
            continue
        w = parts[0].strip().lower()
        if w and set(w) <= alphabet and w not in rank:
            rank[w] = len(rank)
    return rank


def blocked(w, block, prefixes):
    return w in block or w.startswith(prefixes)


def stable_shuffle(items, seed):
    items = sorted(items)
    random.Random(seed).shuffle(items)
    return items


def make_bee_puzzles(words, pangram_pool, min_n, max_n, max_score, forbidden, seed, limit):
    """Picks (letter set, center) pairs whose answer list has a sensible size."""
    by_set = defaultdict(list)
    for w in words:
        by_set[frozenset(w)].append(w)

    sets = sorted({frozenset(w) for w in pangram_pool if len(set(w)) == 7},
                  key=lambda s: "".join(sorted(s)))
    rng = random.Random(seed)
    puzzles = []
    for s in sets:
        if s & forbidden:
            continue
        letters = sorted(s)
        # every word whose letters are a subset of s
        pool = []
        for mask in range(1, 128):
            sub = frozenset(letters[i] for i in range(7) if mask >> i & 1)
            pool.extend(by_set.get(sub, ()))
        centers = []
        for c in letters:
            ans = [w for w in pool if c in w]
            score = sum(1 if len(w) == 4 else len(w) + (7 if len(set(w)) == 7 else 0) for w in ans)
            if min_n <= len(ans) <= max_n and score <= max_score:
                centers.append(c)
        if centers:
            c = rng.choice(centers)
            puzzles.append(c + "".join(l for l in letters if l != c))
    puzzles = stable_shuffle(puzzles, seed)[:limit]
    return puzzles


def write_js(lang, data):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, lang + ".js")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("// Generálta: tools/build_words.py — ne szerkeszd kézzel.\n")
        f.write("window.WORDGAME_DATA = window.WORDGAME_DATA || {};\n")
        f.write("window.WORDGAME_DATA.%s = {\n" % lang)
        for key, words in data.items():
            f.write('  %s: "%s",\n' % (key, " ".join(words)))
        f.write("};\n")
    print("%s: %d KB" % (path, os.path.getsize(path) // 1024))


def build_en():
    enable = {w.strip() for w in read_lines("enable1.txt") if w.strip()}
    freq = read_freq("en_50k.txt", EN_ALPHABET)
    common = {w for w in freq if w in enable}

    def is_inflected(w):
        if w.endswith("s") and not w.endswith("ss") and (w[:-1] in enable or (w.endswith("es") and w[:-2] in enable)):
            return True
        if w.endswith("ed") and (w[:-1] in enable or w[:-2] in enable):
            return True
        return False

    guesses = sorted(w for w in enable if len(w) == 5)
    answers = [w for w in common if len(w) == 5 and not is_inflected(w)
               and not blocked(w, EN_BLOCK, EN_BLOCK_PREFIX)]
    answers = sorted(answers, key=lambda w: freq[w])[:2100]

    bee_words = sorted(w for w in common if len(w) >= 4 and len(set(w)) <= 7 and "s" not in w
                       and not blocked(w, EN_BLOCK, EN_BLOCK_PREFIX))
    pangram_pool = [w for w in bee_words if freq[w] < 30000]
    puzzles = make_bee_puzzles(bee_words, pangram_pool, 20, 60, 260, set("s"), 2026, 1500)

    print("EN wordle answers %d, guesses %d, bee words %d, bee puzzles %d"
          % (len(answers), len(guesses), len(bee_words), len(puzzles)))
    write_js("en", {
        "wordleAnswers": stable_shuffle(answers, 11),
        "wordleGuesses": guesses,
        "beeWords": bee_words,
        "beePuzzles": puzzles,
    })


def build_hu():
    # Hunspell flag aliases of inflected entries: verb forms (tette, látta),
    # pronoun forms (velük, rájuk) and plurals (vágyak). Only base forms are kept.
    inflected_flags = {"178", "156", "1090"}
    lemmas, capitalized = set(), set()
    for line in read_lines("hu_HU.dic")[1:]:
        w, _, flag = line.split("\t")[0].partition("/")
        w = w.strip()
        if not w or " " in w or "-" in w or "." in w:
            continue
        if w != w.lower():
            capitalized.add(w.lower())
            continue
        if flag.strip() in inflected_flags:
            continue
        if set(w) <= HU_ALPHABET:
            lemmas.add(w)
    names = capitalized - lemmas
    freq = read_freq("hu_50k.txt", HU_ALPHABET)
    freq = {w: r for w, r in freq.items() if w not in names}
    common = {w for w in lemmas if w in freq}

    guesses = sorted({w for w in lemmas if len(w) == 5} | {w for w in freq if len(w) == 5})
    answers = [w for w in common if len(w) == 5 and not blocked(w, HU_BLOCK, HU_BLOCK_PREFIX)]
    answers = sorted(answers, key=lambda w: freq[w])[:2600]

    bee_words = sorted(w for w in common if len(w) >= 4 and len(set(w)) <= 7
                       and not blocked(w, HU_BLOCK, HU_BLOCK_PREFIX))
    puzzles = make_bee_puzzles(bee_words, bee_words, 15, 60, 260, set("qwx"), 2026, 1500)

    print("HU wordle answers %d, guesses %d, bee words %d, bee puzzles %d"
          % (len(answers), len(guesses), len(bee_words), len(puzzles)))
    write_js("hu", {
        "wordleAnswers": stable_shuffle(answers, 11),
        "wordleGuesses": guesses,
        "beeWords": bee_words,
        "beePuzzles": puzzles,
    })


if __name__ == "__main__":
    download()
    build_en()
    build_hu()
