from __future__ import annotations

import argparse
import json
from pathlib import Path

import polars as pl

VALID_THEMES = {
    "advancedPawn",
    "advantage",
    "anastasiaMate",
    "arabianMate",
    "attackingF2F7",
    "attraction",
    "backRankMate",
    "balestraMate",
    "blindSwineMate",
    "bishopEndgame",
    "bodenMate",
    "castling",
    "capturingDefender",
    "clearance",
    "collinearMove",
    "cornerMate",
    "crushing",
    "defensiveMove",
    "deflection",
    "discoveredAttack",
    "discoveredCheck",
    "doubleBishopMate",
    "doubleCheck",
    "dovetailMate",
    "endgame",
    "epauletteMate",
    "equality",
    "exposedKing",
    "fork",
    "hangingPiece",
    "hookMate",
    "interference",
    "intermezzo",
    "killBoxMate",
    "kingsideAttack",
    "knightEndgame",
    "long",
    "master",
    "masterVsMaster",
    "mate",
    "mateIn1",
    "mateIn2",
    "mateIn3",
    "mateIn4",
    "mateIn5",
    "middlegame",
    "morphysMate",
    "oneMove",
    "opening",
    "operaMate",
    "pawnEndgame",
    "pillsburysMate",
    "pin",
    "promotion",
    "queenEndgame",
    "queenRookEndgame",
    "queensideAttack",
    "quietMove",
    "rookEndgame",
    "sacrifice",
    "short",
    "skewer",
    "smotheredMate",
    "superGM",
    "swallowstailMate",
    "trappedPiece",
    "triangleMate",
    "underPromotion",
    "veryLong",
    "vukovicMate",
    "xRayAttack",
    "zugzwang",
}

THEME_ALIASES = {theme.lower(): theme for theme in VALID_THEMES}
THEME_ALIASES["mix"] = "mix"


def normalize_theme(value: str) -> str | None:
    compact = "".join(char for char in value if char.isalnum()).lower()
    return THEME_ALIASES.get(compact)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a compact PuzzleArena pack from the Lichess puzzle CSV."
    )
    parser.add_argument(
        "csv",
        type=Path,
        nargs="?",
        default=Path("data/puzzles.csv"),
        help="Path to the Lichess puzzle CSV. Defaults to data/puzzles.csv.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("public/puzzles/lichess-pack.json"),
        help="Output JSON pack path.",
    )
    parser.add_argument("--min-rating", type=int, default=800)
    parser.add_argument("--max-rating", type=int, default=2400)
    parser.add_argument("--min-popularity", type=int, default=60)
    parser.add_argument("--min-plays", type=int, default=50)
    parser.add_argument(
        "--themes",
        default="mix",
        help="Comma-separated theme filter from the supported theme list. Use mix for all themes.",
    )
    parser.add_argument("--limit", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=64)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    requested_themes = [
        normalize_theme(theme) for theme in args.themes.split(",") if theme.strip()
    ]
    themes = sorted({theme for theme in requested_themes if theme and theme != "mix"})

    query = (
        pl.scan_csv(args.csv)
        .filter(pl.col("Rating").is_between(args.min_rating, args.max_rating))
        .filter(pl.col("Popularity") >= args.min_popularity)
        .filter(pl.col("NbPlays") >= args.min_plays)
    )

    if themes:
        theme_filter = pl.any_horizontal(
            [pl.col("Themes").str.contains(rf"(^|\s){theme}(\s|$)") for theme in themes]
        )
        query = query.filter(theme_filter)

    frame = query.select(
        [
            "PuzzleId",
            "FEN",
            "Moves",
            "Rating",
            "Popularity",
            "NbPlays",
            "Themes",
            "GameUrl",
            "OpeningTags",
        ]
    ).collect()

    frame = frame.with_columns(
        pl.col("Themes")
        .str.split(" ")
        .list.eval(pl.element().filter(pl.element().is_in(sorted(VALID_THEMES))))
        .list.join(" ")
        .alias("Themes")
    ).filter(pl.col("Themes") != "")

    if frame.height > args.limit:
        frame = frame.sample(n=args.limit, seed=args.seed, shuffle=True)

    rows = frame.rename(
        {
            "PuzzleId": "id",
            "FEN": "fen",
            "Moves": "moves",
            "Rating": "rating",
            "Popularity": "popularity",
            "NbPlays": "plays",
            "Themes": "themes",
            "GameUrl": "gameUrl",
            "OpeningTags": "openingTags",
        }
    ).to_dicts()

    payload = {
        "source": str(args.csv),
        "count": len(rows),
        "filters": {
            "minRating": args.min_rating,
            "maxRating": args.max_rating,
            "minPopularity": args.min_popularity,
            "minPlays": args.min_plays,
            "themes": themes,
        },
        "puzzles": rows,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(rows):,} puzzles to {args.out}")


if __name__ == "__main__":
    main()
