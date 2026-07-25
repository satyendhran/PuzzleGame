from __future__ import annotations

import argparse
import json
from pathlib import Path

import polars as pl


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a compact PuzzleArena pack from the Lichess puzzle CSV."
    )
    parser.add_argument("csv", type=Path, help="Path to lichess_db_puzzle.csv")
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
        default="",
        help="Comma-separated theme filter. Example: fork,mateIn2,endgame",
    )
    parser.add_argument("--limit", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=64)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    themes = [theme.strip() for theme in args.themes.split(",") if theme.strip()]

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
        "source": "lichess_db_puzzle.csv",
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
