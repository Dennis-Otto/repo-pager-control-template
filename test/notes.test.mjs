// The check of Claude's translation of the notes of a release: what each line keeps
// of its English, as the pager checks it again, and the length of all of them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkTranslation,
  fold,
  links,
  lost,
  NOTES,
  names,
  references,
  spans,
} from "../pager/notes.mjs";

describe("what a line of notes holds", () => {
  it("finds the references that the message links, in order", () => {
    assert.equal(
      references("fix the check (#12) and #791, see #3"),
      "12 3 791",
    );
    assert.equal(references("#5 first"), "5");
    // A number in a word or a link is no reference.
    assert.equal(references("issue#4 and https://x.example/#7"), "");
  });

  it("finds the names of code as the pager does, without the marks around them", () => {
    assert.deepEqual(
      names(
        'bump anchore/syft to v1.56.0 ("check.sh", .github, Node.js, @types/node, check_name) e.g. it',
      ),
      [
        "anchore/syft",
        "v1.56.0",
        "check.sh",
        ".github",
        "Node.js",
        "@types/node",
        "check_name",
      ],
    );
    assert.deepEqual(names("A plain line, e.g. this one."), []);
  });

  it("finds the code spans and the links", () => {
    assert.deepEqual(spans("run `npm test` and `npm run lint`"), [
      "`npm test`",
      "`npm run lint`",
    ]);
    assert.deepEqual(spans("no span, one ` tick"), []);
    assert.deepEqual(links('see https://a.example/x, and "http://b.example"'), [
      "https://a.example/x,",
      "http://b.example",
    ]);
    assert.deepEqual(links("none here"), []);
  });

  it("folds a line into one, trimmed", () => {
    assert.equal(fold("  two\n  lines\t here "), "two lines here");
  });
});

describe("a translated line", () => {
  const english = "run `npm test` in check.sh after #12";

  it("keeps every reference, code span and name of code of its English", () => {
    assert.equal(
      lost(english, "`npm test` in check.sh nach #12 ausführen"),
      "",
    );
    // A name may grow into a German word: Node.js-Version keeps Node.js.
    assert.equal(lost("the Node.js version", "die Node.js-Version"), "");
  });

  it("says what it lost or added", () => {
    assert.equal(lost(english, ""), "is empty");
    assert.equal(
      lost(english, "x".repeat(NOTES.translated + 1)),
      `has more than ${NOTES.translated} characters`,
    );
    assert.equal(
      lost(english, "`npm test` in check.sh ausführen"),
      "has the references none for #12",
    );
    assert.equal(
      lost("a plain line", "eine schlichte Zeile, siehe #4 und #9"),
      "has the references #4 #9 for none",
    );
    assert.equal(
      lost(english, "npm test in check.sh nach #12 ausführen"),
      'lost "`npm test`"',
    );
    assert.equal(
      lost(english, "`npm test` in check-sh nach #12 ausführen"),
      'lost "check.sh"',
    );
    assert.equal(
      lost("a plain line", "Zeile, siehe https://evil.example/update"),
      'adds the link "https://evil.example/update"',
    );
    // Words that Telegram links by itself count as links too.
    assert.equal(
      lost("a plain line", "Zeile, besuche evil.example"),
      'adds the link "evil.example"',
    );
    assert.equal(
      lost("a plain line", "Zeile, frag @evil_bot"),
      'adds the link "@evil_bot"',
    );
    assert.equal(
      lost("a plain line", "Zeile, tippe /start"),
      'adds the link "/start"',
    );
    assert.equal(
      lost("a plain line", "Zeile an a@evil.example"),
      'adds the link "a@evil.example"',
    );
    // German abbreviations are none, and a link of its English may stay.
    assert.equal(lost("a plain line", "eine Zeile, z.B. bzw. d.h. usw."), "");
    assert.equal(
      lost("see https://a.example/x", "siehe https://a.example/x"),
      "",
    );
    assert.equal(
      lost("ask @a_bot about check.sh", "frag @a_bot zu check.sh"),
      "",
    );
  });

  it("names a long piece that it lost in a few characters", () => {
    const path = `docs/${"a".repeat(80)}.md`;
    const why = lost(`read ${path}`, "lies es");
    assert.match(why, /^lost "docs\/a+…"$/);
    assert.equal(JSON.parse(why.slice("lost ".length)).length, 60);
  });
});

describe("a translation of the notes", () => {
  const english = ["the pager speaks German", "bump anchore/syft (#4)"];

  it("is its lines folded, when every one keeps its English", () => {
    assert.deepEqual(
      checkTranslation(english, [
        "  der Pager\nspricht Deutsch ",
        "anchore/syft angehoben (#4)",
      ]),
      {
        lines: ["der Pager spricht Deutsch", "anchore/syft angehoben (#4)"],
        why: "",
      },
    );
  });

  it("is none, with the reason, for another number of lines or a line that lost something", () => {
    assert.deepEqual(checkTranslation(english, ["eins"]), {
      lines: null,
      why: "the translation has 1 line for 2",
    });
    assert.equal(
      checkTranslation(english, ["eins", "zwei", "drei"]).why,
      "the translation has 3 lines for 2",
    );
    assert.deepEqual(
      checkTranslation(english, ["der Pager spricht Deutsch", "syft (#4)"]),
      {
        lines: null,
        why: 'line 2 of the translation lost "anchore/syft"',
      },
    );
  });

  it("is none when all lines together don't fit the message", () => {
    // Short English lines with long translations: each fits, all together don't.
    const short = Array.from({ length: 4 }, () => "a");
    const long = Array.from({ length: 4 }, () => "b".repeat(NOTES.translated));
    assert.deepEqual(checkTranslation(short, long), {
      lines: null,
      why: `the translation has more than ${4 + NOTES.shown} characters`,
    });
    const fits = Array.from({ length: 4 }, () => "b".repeat(301));
    assert.equal(checkTranslation(short, fits).lines.length, 4);
  });
});
