"""既知入力テスト: bad.md で全ルールが発火し、clean.md で誤検知ゼロであることを確認する。"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from wslsp.engine import Engine, default_rules_path  # noqa: E402

FIXTURES = os.path.join(ROOT, "tests", "fixtures")

EXPECTED_BAD = {
    "ai-slop.p1.em-dash",
    "ai-slop.p1.fullwidth-slash",
    "ai-slop.p1.arrow-causal",
    "ai-slop.p1.kagikakko-overuse",
    "ai-slop.p1.bold-keyword",
    "ai-slop.p1.bold-generic",
    "ai-slop.p2.ending-repetition",
    "ai-slop.p2.connective-run",
    "ai-slop.p2.not-a-but-b",
    "ai-slop.p3.meta-structure",
    "ai-slop.p4.hedging",
    "ai-slop.p5.abstract-word",
    "ai-slop.p6.template-metaphor",
    "ai-slop.p6.metaphor-engine-dna",
    "ai-slop.p7.migration-history",
    "style.filler-connective",
    "style.slang",
    "style.decoration-adverb",
    "style.emoji",
    "format.bare-pr-number",
    "format.url-adjacency",
    "obsidian.prefer-bare-url",
    "ref.wikilink-missing",
    "ref.md-link-missing",
    "ref.absolute-path-link",
}


def main() -> int:
    engine = Engine([default_rules_path()], enable_categories=["obsidian"])

    bad = engine.lint_file(os.path.join(FIXTURES, "bad.md"))
    fired = {d.rule_id for d in bad}
    missing = EXPECTED_BAD - fired
    extra = fired - EXPECTED_BAD
    ok = True
    if missing:
        print(f"NG: bad.md で発火しなかったルール: {sorted(missing)}")
        ok = False
    if extra:
        print(f"NG: bad.md で想定外に発火したルール: {sorted(extra)}")
        ok = False
    print(f"bad.md: {len(bad)} diagnostics / {len(fired)} rules fired (expected {len(EXPECTED_BAD)})")

    clean = engine.lint_file(os.path.join(FIXTURES, "clean.md"))
    if clean:
        print(f"NG: clean.md で誤検知 {len(clean)} 件:")
        for d in clean:
            print(f"  {d.line}:{d.col} [{d.rule_id}] {d.message} ›{d.snippet}‹")
        ok = False
    else:
        print("clean.md: 0 diagnostics (誤検知なし)")

    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
