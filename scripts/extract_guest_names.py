#!/usr/bin/env python3
"""
Trekk ut sannsynlige personnavn fra episodetitler i _episodes/ med spaCy norsk NER.

Anbefalt oppsett (PEP 668 / Homebrew-Python):
  python3 -m venv scripts/.venv-ner
  source scripts/.venv-ner/bin/activate
  pip install -r scripts/requirements-ner.txt
  python -m spacy download nb_core_news_sm

Kjør fra prosjektrot (med venv aktivert):
  python scripts/extract_guest_names.py
  python scripts/extract_guest_names.py --out rapport.csv --json rapport.json
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

try:
    import yaml
except ImportError as e:
    print("Mangler PyYAML. Kjør: pip install -r scripts/requirements-ner.txt", file=sys.stderr)
    raise SystemExit(1) from e


ROOT = Path(__file__).resolve().parents[1]
EPISODES_DIR = ROOT / "_episodes"


def load_front_matter(path: Path) -> dict | None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return None
    # Første --- ... andre --- = front matter (Jekyll)
    rest = text[3:].lstrip("\n")
    idx = rest.find("\n---")
    if idx == -1:
        return None
    fm_raw = rest[:idx]
    try:
        data = yaml.safe_load(fm_raw) or {}
        return data if isinstance(data, dict) else None
    except yaml.YAMLError:
        return None


def normalize_title(s: str) -> str:
    s = s.replace("\n", " ").replace("\r", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def normalize_name_key(name: str) -> str:
    """Slå sammen varianter for telling (ikke perfekt)."""
    s = name.strip()
    s = re.sub(r"\s+", " ", s)
    return s.casefold()


def load_nlp(model: str):
    try:
        import spacy
    except ImportError as e:
        print(
            "Mangler spaCy. Kjør:\n"
            "  pip install -r scripts/requirements-ner.txt\n"
            "  python -m spacy download nb_core_news_sm",
            file=sys.stderr,
        )
        raise SystemExit(1) from e
    try:
        return spacy.load(model)
    except OSError as e:
        print(
            f"Fant ikke modellen «{model}». Installer med:\n"
            f"  python -m spacy download {model}",
            file=sys.stderr,
        )
        raise SystemExit(1) from e


def main() -> None:
    ap = argparse.ArgumentParser(description="NER-basert navneliste fra _episodes-titler.")
    ap.add_argument(
        "--episodes-dir",
        type=Path,
        default=EPISODES_DIR,
        help="Mappe med episode-*.md (standard: _episodes/)",
    )
    ap.add_argument(
        "--model",
        default="nb_core_news_sm",
        help="spaCy-modell (standard: nb_core_news_sm). Prøv nb_core_news_lg for bedre treff.",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=ROOT / "scripts" / "guest_names_report.csv",
        help="CSV-rapport (standard: scripts/guest_names_report.csv)",
    )
    ap.add_argument("--json", type=Path, default=None, help="Valgfri JSON-rapport med samme data.")
    ap.add_argument(
        "--min-episodes",
        type=int,
        default=1,
        help="Kun navn som forekommer i minst N episoder (standard: 1).",
    )
    args = ap.parse_args()

    ep_dir: Path = args.episodes_dir
    if not ep_dir.is_dir():
        print(f"Fant ikke episodemapper: {ep_dir}", file=sys.stderr)
        raise SystemExit(1)

    nlp = load_nlp(args.model)

    # slug (filnavn uten .md) -> tittel
    episodes: list[tuple[str, str]] = []
    for path in sorted(ep_dir.glob("*.md")):
        fm = load_front_matter(path)
        if not fm:
            continue
        raw = fm.get("title")
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            continue
        title = normalize_title(str(raw))
        if not title:
            continue
        slug = path.stem
        episodes.append((slug, title))

    # name_key -> { canonical, episodes set, labels set, sample_titles }
    agg: dict[str, dict] = defaultdict(
        lambda: {
            "canonical": "",
            "episodes": set(),
            "labels": set(),
            "samples": [],
        }
    )

    person_labels = {"PER", "PERSON"}

    for slug, title in episodes:
        doc = nlp(title[:10000])
        seen_in_title: set[str] = set()
        for ent in doc.ents:
            if ent.label_ not in person_labels:
                continue
            raw_name = ent.text.strip()
            if len(raw_name) < 2:
                continue
            key = normalize_name_key(raw_name)
            if key in seen_in_title:
                continue
            seen_in_title.add(key)
            cell = agg[key]
            cell["episodes"].add(slug)
            cell["labels"].add(ent.label_)
            # Behold «peneste» visningsform: foretrekk lengre / mer ord
            cand = raw_name
            if len(cand) > len(cell["canonical"]):
                cell["canonical"] = cand
            elif not cell["canonical"]:
                cell["canonical"] = cand
            if len(cell["samples"]) < 4 and title not in cell["samples"]:
                cell["samples"].append(title)

    rows = []
    for key, cell in agg.items():
        n_eps = len(cell["episodes"])
        if n_eps < args.min_episodes:
            continue
        rows.append(
            {
                "name": cell["canonical"] or key,
                "name_key": key,
                "episode_count": n_eps,
                "ner_labels": ",".join(sorted(cell["labels"])),
                "sample_titles": " | ".join(cell["samples"][:3]),
            }
        )

    rows.sort(key=lambda r: (-r["episode_count"], r["name"].lower()))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=["name", "episode_count", "ner_labels", "sample_titles"],
            extrasaction="ignore",
        )
        w.writeheader()
        for r in rows:
            w.writerow(r)

    print(f"Skrev {args.out} ({len(rows)} navn, {len(episodes)} episoder med tittel).")

    if args.json:
        payload = {
            "model": args.model,
            "episode_files": len(episodes),
            "names": [
                {
                    "name": r["name"],
                    "episode_count": r["episode_count"],
                    "ner_labels": r["ner_labels"],
                    "sample_titles": r["sample_titles"],
                }
                for r in rows
            ],
        }
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Skrev {args.json}")


if __name__ == "__main__":
    main()
