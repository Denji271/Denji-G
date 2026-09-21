// Cards for the home page: name, link, icon and the text of the info bubble.
(function () {
  "use strict";

  const tile = (ch, state) => '<span class="mini-tile" style="background:var(--' + state + ')">' + ch + "</span>";
  const icon = (body) => '<div class="card-icon">' + body + "</div>";
  const svg = (body) => icon('<svg viewBox="0 0 84 44" aria-hidden="true">' + body + "</svg>");

  // Small square grids used by several icons
  function squares(rows, size, x0, y0) {
    let out = "";
    rows.forEach((row, r) => {
      row.forEach((fill, c) => {
        if (!fill) return;
        out +=
          '<rect x="' + (x0 + c * size) + '" y="' + (y0 + r * size) + '" width="' + (size - 1.2) +
          '" height="' + (size - 1.2) + '" rx="1.4" fill="' + fill + '"/>';
      });
    });
    return out;
  }

  const GREEN = "var(--correct)";
  const YELLOW = "var(--present)";
  const GREY = "var(--absent)";
  const SURFACE = "var(--key-bg)";
  const INK = "var(--text)";

  const WORD = [
    {
      id: "wordle",
      name: "Wordle",
      url: "wordle.html",
      icon: icon(tile("W", "correct") + tile("O", "absent") + tile("R", "present") + tile("D", "correct") + tile("L", "absent")),
      info:
        "Guess a hidden five-letter word in six tries. After every guess a green tile means the letter is " +
        "in the right spot, yellow means it is in the word but somewhere else, and grey means it is not in " +
        "the word at all.",
    },
    {
      id: "bee",
      name: "Spelling Bee",
      url: "bee.html",
      icon: icon('<span class="mini-hex">B</span><span class="mini-hex center">E</span><span class="mini-hex">E</span>'),
      info:
        "Build as many words as you can from seven letters. Every word needs at least four letters and has " +
        "to contain the centre letter; the others may repeat freely. Longer words score more.",
    },
    {
      id: "letterboxed",
      name: "Letter Boxed",
      url: "letterboxed.html",
      icon: svg(
        '<rect x="23" y="4" width="38" height="36" rx="3" fill="none" stroke="var(--border-strong)" stroke-width="1.6"/>' +
          '<path d="M30 4 58 15 27 29 45 40" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round"/>' +
          '<circle cx="30" cy="4" r="2.8" fill="' + GREEN + '"/><circle cx="42" cy="4" r="2.8" fill="' + GREY + '"/><circle cx="54" cy="4" r="2.8" fill="' + GREY + '"/>' +
          '<circle cx="30" cy="40" r="2.8" fill="' + GREY + '"/><circle cx="45" cy="40" r="2.8" fill="' + GREEN + '"/><circle cx="56" cy="40" r="2.8" fill="' + GREY + '"/>' +
          '<circle cx="23" cy="15" r="2.8" fill="' + GREY + '"/><circle cx="27" cy="29" r="2.8" fill="' + GREEN + '"/>' +
          '<circle cx="58" cy="15" r="2.8" fill="' + GREEN + '"/><circle cx="61" cy="29" r="2.8" fill="' + GREY + '"/>'
      ),
      info:
        "Twelve letters sit around the four sides of a square. Spell words in which no two consecutive " +
        "letters come from the same side, and start every new word with the last letter of the previous " +
        "one. The goal is to use all twelve letters.",
    },
    {
      id: "wordsearch",
      name: "Word Search",
      url: "wordsearch.html",
      icon: svg(
        '<path d="M12 9 48 37" stroke="' + GREEN + '" stroke-width="15" stroke-linecap="round" opacity="0.45"/>' +
          '<g font-size="11" font-weight="700" text-anchor="middle" fill="' + INK + '">' +
          '<text x="12" y="13">S</text><text x="30" y="13">R</text><text x="48" y="13">T</text><text x="66" y="13">K</text>' +
          '<text x="12" y="27">L</text><text x="30" y="27">U</text><text x="48" y="27">Z</text><text x="66" y="27">E</text>' +
          '<text x="12" y="41">A</text><text x="30" y="41">B</text><text x="48" y="41">N</text><text x="66" y="41">O</text></g>'
      ),
      info:
        "Find the listed words hidden in a grid of letters. They can run in any direction, including " +
        "backwards and diagonally — drag from the first letter to the last, or tap the two ends.",
    },
    {
      id: "waffle",
      name: "Waffle",
      url: "waffle.html",
      icon: svg(
        squares(
          [
            [GREEN, YELLOW, GREY, YELLOW, GREEN],
            [YELLOW, null, GREEN, null, GREY],
            [GREY, GREEN, YELLOW, GREY, GREEN],
            [GREEN, null, GREY, null, YELLOW],
            [YELLOW, GREY, GREEN, GREEN, GREY],
          ],
          8,
          22,
          2
        )
      ),
      info:
        "Six words are jumbled into a five-by-five grid. Click two tiles and they swap places: green means " +
        "the letter is home, yellow means it belongs somewhere else in that word. You get fifteen swaps.",
    },
    {
      id: "ladder",
      name: "Word Ladder",
      url: "ladder.html",
      icon: svg(
        '<g font-size="12" font-weight="800" text-anchor="middle" fill="' + INK + '" letter-spacing="1">' +
          '<text x="38" y="13">CAT</text><text x="38" y="28">COT</text><text x="38" y="43">DOT</text></g>' +
          '<path d="M66 6v7M66 21v7" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round"/>' +
          '<path d="m63 10 3 3 3-3M63 25l3 3 3-3" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
      ),
      info:
        "Climb from the top word to the bottom one by changing a single letter at a time. Every rung in " +
        "between has to be a real word, and the fewer steps you take, the better.",
    },
    {
      id: "connections",
      name: "Connections",
      url: "connections.html",
      icon: svg(
        squares(
          [
            [YELLOW, YELLOW, YELLOW, YELLOW],
            [GREEN, GREEN, GREEN, GREEN],
            ["var(--accent)", "var(--accent)", "var(--accent)", "var(--accent)"],
            ["#9a5bd6", "#9a5bd6", "#9a5bd6", "#9a5bd6"],
          ],
          10.5,
          21,
          1
        )
      ),
      info:
        "Sort sixteen words into four groups of four. Each group shares a hidden theme, and several words " +
        "look like they would fit in more than one place. Four mistakes and the puzzle is over.",
    },
    {
      id: "crossword",
      name: "Mini Crossword",
      url: "crossword.html",
      icon: svg(
        squares(
          [
            [SURFACE, SURFACE, SURFACE, SURFACE, INK],
            [SURFACE, SURFACE, SURFACE, SURFACE, SURFACE],
            [SURFACE, SURFACE, SURFACE, SURFACE, SURFACE],
            [SURFACE, SURFACE, SURFACE, SURFACE, SURFACE],
            [INK, SURFACE, SURFACE, SURFACE, SURFACE],
          ],
          8,
          22,
          2
        ) +
          '<rect x="22" y="2" width="38.8" height="38.8" fill="none" stroke="var(--border-strong)" stroke-width="1.4"/>' +
          '<g font-size="7" font-weight="700" fill="var(--muted)"><text x="23.5" y="8.5">1</text><text x="31.5" y="8.5">2</text><text x="23.5" y="24.5">3</text></g>'
      ),
      info:
        "A five-by-five crossword with short clues. Click a square and start typing — the across and down " +
        "answers cross each other, so every solved word helps with the next one.",
    },
    {
      id: "cryptogram",
      name: "Cryptogram",
      url: "cryptogram.html",
      icon: svg(
        '<g font-size="13" font-weight="800" text-anchor="middle">' +
          '<text x="18" y="17" fill="var(--muted)">X</text><text x="36" y="17" fill="var(--muted)">Q</text>' +
          '<text x="54" y="17" fill="var(--muted)">Z</text><text x="72" y="17" fill="var(--muted)">P</text>' +
          '<text x="18" y="41" fill="' + GREEN + '">W</text><text x="36" y="41" fill="' + GREEN + '">O</text>' +
          '<text x="54" y="41" fill="' + GREEN + '">R</text><text x="72" y="41" fill="var(--border-strong)">?</text></g>' +
          '<path d="M10 24h66" stroke="var(--border)" stroke-width="1.5"/>'
      ),
      info:
        "Every letter of a proverb has been swapped for a different one, always the same way. Use the word " +
        "lengths and the most common letters to work the original sentence back out.",
    },
  ];

  const PUZZLE = [
    {
      id: "nerdle",
      name: "Nerdle",
      url: "nerdle.html",
      icon: icon(tile("1", "correct") + tile("2", "absent") + tile("+", "present") + tile("7", "absent") + tile("=", "correct")),
      info:
        "Wordle with numbers: guess an eight-character equation in six tries. The colours mean the same as " +
        "in Wordle, and a guess is only accepted if the equation is actually true.",
    },
    {
      id: "sudoku",
      name: "Sudoku",
      url: "sudoku.html",
      icon: svg(
        '<rect x="22" y="2" width="40" height="40" rx="2" fill="' + SURFACE + '" stroke="var(--border-strong)" stroke-width="1.5"/>' +
          '<path d="M35.3 2v40M48.6 2v40M22 15.3h40M22 28.6h40" stroke="var(--border-strong)" stroke-width="1"/>' +
          '<g font-size="10" font-weight="700" text-anchor="middle" fill="' + INK + '">' +
          '<text x="28.5" y="13">5</text><text x="42" y="26">3</text><text x="55.5" y="39">8</text>' +
          '<text x="55.5" y="13">1</text><text x="28.5" y="39">9</text></g>'
      ),
      info:
        "A nine-by-nine grid in which every row, every column and every three-by-three box has to contain " +
        "each digit from 1 to 9 exactly once. Three difficulty levels, one fresh puzzle every day.",
    },
    {
      id: "nonogram",
      name: "Nonogram",
      url: "nonogram.html",
      icon: svg(
        '<g font-size="7.5" font-weight="700" fill="var(--muted)">' +
          '<text x="6" y="19">2 1</text><text x="10" y="30">1 1</text><text x="14" y="41">3</text>' +
          '<text x="32" y="10">3</text><text x="44" y="10">1</text><text x="56" y="10">2</text></g>' +
          squares(
            [
              [INK, SURFACE, INK],
              [SURFACE, INK, INK],
              [INK, INK, SURFACE],
            ],
            11.5,
            29,
            12
          ) +
          '<rect x="29" y="12" width="34" height="34" fill="none" stroke="var(--border-strong)" stroke-width="1.2"/>'
      ),
      info:
        "The numbers beside each row and column tell you how many squares are filled in one unbroken run. " +
        "From those clues alone you work out which squares are black and which stay empty.",
    },
    {
      id: "mastermind",
      name: "Mastermind",
      url: "mastermind.html",
      icon: svg(
        '<circle cx="17" cy="22" r="8.5" fill="' + GREEN + '"/><circle cx="36" cy="22" r="8.5" fill="' + YELLOW + '"/>' +
          '<circle cx="55" cy="22" r="8.5" fill="var(--accent)"/><circle cx="74" cy="22" r="8.5" fill="#9a5bd6"/>'
      ),
      info:
        "Crack a hidden code of four colours in ten guesses. After each try you learn how many pegs are the " +
        "right colour in the right place, and how many are the right colour in the wrong place.",
    },
  ];

  window.GAMES = { word: WORD, puzzle: PUZZLE, all: WORD.concat(PUZZLE) };
})();
