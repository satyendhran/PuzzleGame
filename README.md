# PuzzleArena

PuzzleArena is a local-network chess puzzle battle app for club events. One host logs in, players join with nicknames, the host previews and starts puzzles, everyone solves on a clickable board, and the server owns timing, validation, scoring, leaderboard state, and CSV export.

## What works

- Player-only home page at `/`
- Host login with `HOST_PASSWORD` at `/admin`
- TV projection view at `/tv`
- Empty lobby until real players join
- Live Socket.IO room updates
- Host puzzle preview, round start, force-end, and session end
- Rating, popularity, theme, timer, scoring curve, max-points, and cutoff settings
- Drag or click-to-move player board with immediate move submission
- Server-side full solution-line validation, including multi-move puzzles and automatic opponent replies
- Server-authoritative timer and scoring
- Live roster, leaderboard, TV view, reveal state, and CSV export
- Polars puzzle-pack builder from `data/puzzles.csv`

## Prepare Puzzles

Put the decompressed Lichess puzzle CSV here:

```text
data/puzzles.csv
```

Build a production-size puzzle pack:

```powershell
python scripts\build_puzzle_pack.py --min-rating 800 --max-rating 2400 --min-popularity 60 --min-plays 50 --themes mix --limit 50000
```

## Run

```powershell
npm.cmd install
$env:HOST_PASSWORD="change-this-password"
npm.cmd start
```

Open:

```text
http://localhost:3000/
```

The host opens `/admin`, enters `HOST_PASSWORD`, and gets a fresh Room ID. Players open `/`, enter that Room ID and a nickname, then play on the board. The projector can open `/tv` and enter the Room ID, or use the admin page’s TV link.

## Test

```powershell
npm.cmd test
```
