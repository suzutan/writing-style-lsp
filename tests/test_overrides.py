"""workspace override (.wslsp.json) のテスト: パス一致でルール・カテゴリを無効化できる。"""
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from wslsp.engine import Engine, WorkspaceConfig, default_rules_path  # noqa: E402

BAD_TEXT = "参照: [[存在しないノート]] は本質的に良くない書き方です。\n"


def main() -> int:
    engine = Engine([default_rules_path()])
    ok = True
    tmp = tempfile.mkdtemp(prefix="wslsp-ov-")
    try:
        os.makedirs(os.path.join(tmp, "periodic"))
        os.makedirs(os.path.join(tmp, "docs"))
        with open(os.path.join(tmp, ".wslsp.json"), "w", encoding="utf-8") as f:
            f.write('{"overrides": [{"paths": "^periodic/", "disable": ["ref.wikilink-missing"]}]}')
        for sub in ("periodic", "docs"):
            with open(os.path.join(tmp, sub, "note.md"), "w", encoding="utf-8") as f:
                f.write(BAD_TEXT)

        WorkspaceConfig._cache.clear()
        excluded = {d.rule_id for d in engine.lint_file(os.path.join(tmp, "periodic", "note.md"))}
        included = {d.rule_id for d in engine.lint_file(os.path.join(tmp, "docs", "note.md"))}

        if "ref.wikilink-missing" in excluded:
            print("NG: periodic/ で ref.wikilink-missing が除外されていない")
            ok = False
        if "ai-slop.p5.abstract-word" not in excluded:
            print("NG: periodic/ で無関係ルールまで消えている")
            ok = False
        if "ref.wikilink-missing" not in included:
            print("NG: docs/ では ref.wikilink-missing が発火するべき")
            ok = False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
