"""CLI: ファイル・ディレクトリを lint し、diagnostics を text / json で出力する。"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import Counter
from typing import List

from .engine import Engine, default_rules_path

SEV_MARK = {"error": "E", "warning": "W", "info": "I", "hint": "H"}


def collect_files(paths: List[str]) -> List[str]:
    files = []
    for p in paths:
        if os.path.isdir(p):
            files.extend(sorted(glob.glob(os.path.join(p, "**", "*.md"), recursive=True)))
        else:
            files.append(p)
    return files


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="wslsp", description="Writing Style linter")
    ap.add_argument("paths", nargs="+", help="lint 対象のファイルまたはディレクトリ")
    ap.add_argument("--rules", action="append", default=[], help="ルール JSON（複数指定可。省略時は rules/core.json）")
    ap.add_argument("--enable-category", action="append", default=[], help="既定 off のカテゴリを有効化（例: rp）")
    ap.add_argument("--disable-category", action="append", default=[], help="カテゴリを無効化")
    ap.add_argument("--min-severity", choices=["error", "warning", "info", "hint"], default="hint",
                    help="この severity 以上のみ表示")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--stat", action="store_true", help="ルール別・カテゴリ別の集計を表示")
    ap.add_argument("--fix", action="store_true", help="fix.replace を持つルールの自動修正を適用")
    ap.add_argument("--fail-on", choices=["error", "warning", "info", "none"], default="none",
                    help="この severity 以上の検出があれば exit 1")
    args = ap.parse_args(argv)

    rules = args.rules or [default_rules_path()]
    engine = Engine(rules, enable_categories=args.enable_category,
                    disable_categories=args.disable_category)

    sev_rank = {"error": 0, "warning": 1, "info": 2, "hint": 3}
    threshold = sev_rank[args.min_severity]

    files = collect_files(args.paths)
    all_diags = []
    total_chars = 0
    for f in files:
        try:
            with open(f, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as e:
            print(f"skip {f}: {e}", file=sys.stderr)
            continue
        total_chars += len(text)

        if args.fix:
            diags = engine.lint_text(text, path=f)
            fixed = text
            for d in sorted(diags, key=lambda d: -d.start):
                if d.fix and "replace" in d.fix:
                    fixed = fixed[: d.start] + d.fix["replace"] + fixed[d.end :]
            if fixed != text:
                with open(f, "w", encoding="utf-8") as fh:
                    fh.write(fixed)
                print(f"fixed: {f}", file=sys.stderr)
                text = fixed

        diags = [d for d in engine.lint_text(text, path=f) if sev_rank[d.severity] <= threshold]
        all_diags.extend((f, d) for d in diags)

    if args.format == "json":
        print(json.dumps(
            [dict(file=f, **d.to_dict()) for f, d in all_diags],
            ensure_ascii=False, indent=2))
    else:
        for f, d in all_diags:
            print(f"{f}:{d.line}:{d.col} {SEV_MARK[d.severity]} [{d.rule_id}] {d.message}  ›{d.snippet}‹")

    if args.stat:
        by_rule = Counter(d.rule_id for _, d in all_diags)
        by_cat = Counter(d.category for _, d in all_diags)
        by_sev = Counter(d.severity for _, d in all_diags)
        print("\n--- stat ---", file=sys.stderr)
        print(f"files: {len(files)}  chars: {total_chars}  diagnostics: {len(all_diags)}"
              f"  per-1000-chars: {len(all_diags) * 1000 / max(1, total_chars):.2f}", file=sys.stderr)
        print("by severity: " + ", ".join(f"{k}={v}" for k, v in sorted(by_sev.items())), file=sys.stderr)
        print("by category: " + ", ".join(f"{k}={v}" for k, v in sorted(by_cat.items())), file=sys.stderr)
        for rule, n in by_rule.most_common():
            print(f"  {n:4d}  {rule}", file=sys.stderr)

    if args.fail_on != "none":
        if any(sev_rank[d.severity] <= sev_rank[args.fail_on] for _, d in all_diags):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
