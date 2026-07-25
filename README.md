# PuzzleArena

A live chess puzzle battle MVP for club events. The app gives a host a room code, puzzle preview controls, round settings, a live roster, timed puzzle pushes, player submissions, leaderboard movement, final results, and CSV export.

## What is included

- Host, player, and TV leaderboard views in one responsive interface
- Room code and QR-style join display
- Polars-based Lichess CSV import into a compact local puzzle pack
- Puzzle preview, reroll, timed push, force-end, and end-session controls
- Multiple scoring curves: linear, exponential, quadratic, winner-takes-all, and flat participation
- Player answer flow with submit and give up actions
- Live-style roster and leaderboard updates
- Final podium and full standings
- Results export as CSV

## Run locally

```bash
npm install
npm run dev
```

The local preview runs at `http://localhost:3000/`.

## Use the Lichess puzzle CSV

Download and decompress `lichess_db_puzzle.csv.zst` from the Lichess puzzle database so you have a `.csv` file locally. Then build a compact pack for the app:

```bash
python scripts/build_puzzle_pack.py C:\path\to\lichess_db_puzzle.csv --min-rating 900 --max-rating 2200 --min-popularity 60 --min-plays 50 --themes fork,mateIn2,endgame --limit 3000
```

The script uses Polars to scan and filter the full CSV, then writes `public/puzzles/lichess-pack.json`. Reload the app or press `Reload pack` in the host dashboard.

## Build

```bash
npm run build
```

This is currently a frontend MVP with simulated live session data. A production multiplayer version would add the Flask/Socket.IO backend and server-authoritative move validation described in the project specification.
