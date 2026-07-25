"use client";

import { useEffect, useMemo, useState } from "react";

type Curve = "linear" | "exponential" | "quadratic" | "winner" | "flat";
type View = "admin" | "player" | "tv";
type RoundStatus = "lobby" | "preview" | "live" | "reveal" | "results";

type Puzzle = {
  id: string;
  title: string;
  fen: string;
  rating: number;
  themes: string[];
  side: "White" | "Black";
  moves: string[];
  board: string[];
  answer: string;
  note: string;
};

type Player = {
  id: string;
  name: string;
  score: number;
  lastScore: number;
  previousRank: number;
  connected: boolean;
  answered: boolean;
  correct: boolean | null;
  solveTime: number | null;
  streak: number;
  accuracy: number[];
  muted?: boolean;
};

const puzzles: Puzzle[] = [
  {
    id: "PA-1042",
    title: "Back rank deflection",
    fen: "r4rk1/pp3ppp/2p5/4q3/8/2P2Q2/PP3PPP/R4RK1 w - - 0 1",
    rating: 1280,
    themes: ["deflection", "backRank", "mateIn2"],
    side: "White",
    moves: ["Qxf7+", "Rxf7", "Rxf7"],
    board: ["r", "", "", "", "", "r", "k", "", "p", "p", "", "", "", "p", "p", "p", "", "", "p", "", "", "", "", "", "", "", "", "", "q", "", "", "", "", "", "", "", "", "", "", "", "", "", "P", "", "", "Q", "", "", "P", "P", "", "", "", "P", "P", "P", "R", "", "", "", "", "R", "K", ""],
    answer: "Qxf7+",
    note: "Deflect the rook and the back rank collapses.",
  },
  {
    id: "PA-2198",
    title: "Fork on the dark squares",
    fen: "2r2rk1/pp3ppp/4bn2/3q4/3P4/2N1PN2/PPQ2PPP/2R2RK1 w - - 0 1",
    rating: 1510,
    themes: ["fork", "tactic", "middlegame"],
    side: "White",
    moves: ["Nxd5", "Nxd5", "Qh7+"],
    board: ["", "", "r", "", "", "r", "k", "", "p", "p", "", "", "", "p", "p", "p", "", "", "", "", "b", "n", "", "", "", "", "", "q", "", "", "", "", "", "", "", "P", "", "", "", "", "", "", "N", "", "P", "N", "", "", "P", "P", "Q", "", "", "P", "P", "P", "", "", "R", "", "", "R", "K", ""],
    answer: "Nxd5",
    note: "The knight jump wins time and unlocks the queen.",
  },
  {
    id: "PA-3307",
    title: "Quiet mate net",
    fen: "6k1/5ppp/8/8/8/5Q2/5PPP/6K1 w - - 0 1",
    rating: 980,
    themes: ["mateIn1", "queen", "endgame"],
    side: "White",
    moves: ["Qa8#"],
    board: ["", "", "", "", "", "", "k", "", "", "", "", "", "", "p", "p", "p", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Q", "", "", "", "", "", "", "", "P", "P", "P", "", "", "", "", "", "", "K", ""],
    answer: "Qa8#",
    note: "Use the queen's long diagonal and the edge of the board.",
  },
];

const initialPlayers: Player[] = [
  { id: "ava", name: "Ava", score: 420, lastScore: 80, previousRank: 2, connected: true, answered: false, correct: null, solveTime: null, streak: 2, accuracy: [1, 1, 0, 1] },
  { id: "milan", name: "Milan", score: 390, lastScore: 60, previousRank: 1, connected: true, answered: false, correct: null, solveTime: null, streak: 1, accuracy: [1, 0, 1, 1] },
  { id: "zoe", name: "Zoe", score: 320, lastScore: 40, previousRank: 3, connected: true, answered: false, correct: null, solveTime: null, streak: 0, accuracy: [0, 1, 1, 0] },
  { id: "nina", name: "Nina", score: 270, lastScore: 25, previousRank: 5, connected: true, answered: false, correct: null, solveTime: null, streak: 1, accuracy: [1, 0, 0, 1] },
  { id: "omar", name: "Omar", score: 245, lastScore: 0, previousRank: 4, connected: false, answered: false, correct: null, solveTime: null, streak: 0, accuracy: [0, 1, 0, 0] },
  { id: "you", name: "You", score: 210, lastScore: 0, previousRank: 6, connected: true, answered: false, correct: null, solveTime: null, streak: 0, accuracy: [1, 0, 1, 0] },
];

function scoreForRank(rank: number, curve: Curve, maxPoints: number, cutoff: number) {
  if (rank > cutoff && curve !== "flat") return 0;
  if (curve === "winner") return rank === 1 ? maxPoints : 0;
  if (curve === "flat") return maxPoints;
  if (curve === "exponential") return Math.round(maxPoints * Math.pow(0.72, rank - 1));
  const fraction = (cutoff - rank + 1) / cutoff;
  if (curve === "quadratic") return Math.round(maxPoints * fraction * fraction);
  return Math.round(maxPoints * fraction);
}

function rankPlayers(players: Player[]) {
  return [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function rankOf(players: Player[], id: string) {
  return rankPlayers(players).findIndex((player) => player.id === id) + 1;
}

export default function Home() {
  const [view, setView] = useState<View>("admin");
  const [status, setStatus] = useState<RoundStatus>("lobby");
  const [puzzleIndex, setPuzzleIndex] = useState(0);
  const [players, setPlayers] = useState(initialPlayers);
  const [timer, setTimer] = useState(45);
  const [timeLeft, setTimeLeft] = useState(45);
  const [curve, setCurve] = useState<Curve>("linear");
  const [maxPoints, setMaxPoints] = useState(100);
  const [cutoff, setCutoff] = useState(5);
  const [selected, setSelected] = useState<number | null>(null);
  const [moveText, setMoveText] = useState("");
  const [events, setEvents] = useState<string[]>(["Room J4K9 created", "Six players in lobby"]);

  const puzzle = puzzles[puzzleIndex];
  const ranked = useMemo(() => rankPlayers(players), [players]);
  const you = players.find((player) => player.id === "you")!;
  const answeredCount = players.filter((player) => player.answered).length;

  useEffect(() => {
    if (status !== "live") return;
    if (timeLeft <= 0 || answeredCount === players.length) {
      setStatus("reveal");
      setEvents((items) => ["Round ended, solution revealed", ...items].slice(0, 6));
      return;
    }
    const tick = window.setTimeout(() => setTimeLeft((value) => value - 1), 1000);
    return () => window.clearTimeout(tick);
  }, [answeredCount, players.length, status, timeLeft]);

  function previewPuzzle(direction = 1) {
    setPuzzleIndex((index) => (index + direction + puzzles.length) % puzzles.length);
    setStatus("preview");
    setSelected(null);
    setMoveText("");
    setEvents((items) => ["Puzzle preview loaded for host", ...items].slice(0, 6));
  }

  function startRound() {
    setPlayers((list) =>
      list.map((player) => ({
        ...player,
        previousRank: rankOf(list, player.id),
        lastScore: 0,
        answered: false,
        correct: null,
        solveTime: null,
      })),
    );
    setTimeLeft(timer);
    setStatus("live");
    setEvents((items) => [`${puzzle.id} pushed to all boards`, ...items].slice(0, 6));
    window.setTimeout(() => autoSolve("ava", 6.2), 4200);
    window.setTimeout(() => autoSolve("milan", 9.7), 7000);
    window.setTimeout(() => autoSolve("nina", 14.5), 9400);
  }

  function autoSolve(id: string, solveTime: number) {
    setPlayers((list) => {
      if (status !== "live") return list;
      if (list.find((player) => player.id === id)?.answered) return list;
      const rank = list.filter((player) => player.correct).length + 1;
      const points = scoreForRank(rank, curve, maxPoints, cutoff);
      return list.map((player) =>
        player.id === id
          ? {
              ...player,
              score: player.score + points,
              lastScore: points,
              answered: true,
              correct: true,
              solveTime,
              streak: player.streak + 1,
              accuracy: [...player.accuracy, 1],
            }
          : player,
      );
    });
  }

  function submitMove(giveUp = false) {
    if (status !== "live" || you.answered) return;
    const correct = !giveUp && moveText.trim().toLowerCase() === puzzle.answer.toLowerCase();
    const rank = players.filter((player) => player.correct).length + 1;
    const elapsed = timer - timeLeft + Math.max(0.2, Math.random() * 0.8);
    const points = correct ? scoreForRank(rank, curve, maxPoints, cutoff) : 0;
    setPlayers((list) =>
      list.map((player) =>
        player.id === "you"
          ? {
              ...player,
              score: player.score + points,
              lastScore: points,
              answered: true,
              correct,
              solveTime: giveUp ? null : Number(elapsed.toFixed(1)),
              streak: correct ? player.streak + 1 : 0,
              accuracy: [...player.accuracy, correct ? 1 : 0],
            }
          : player,
      ),
    );
    setEvents((items) => [`${correct ? "Correct" : giveUp ? "Gave up" : "Wrong"} submission from You`, ...items].slice(0, 6));
  }

  function endSession() {
    setStatus("results");
    setEvents((items) => ["Final results locked", ...items].slice(0, 6));
  }

  function exportCsv() {
    const csv = ["rank,name,score,accuracy,average_solve_time", ...ranked.map((player, index) => {
      const accuracy = Math.round((player.accuracy.reduce((sum, value) => sum + value, 0) / player.accuracy.length) * 100);
      return `${index + 1},${player.name},${player.score},${accuracy}%,${player.solveTime ?? ""}`;
    })].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "puzzlearena-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  const ownRank = rankOf(players, "you");
  const playerAbove = ranked[ownRank - 2];
  const topFive = ranked.slice(0, 5);
  const showPinnedYou = ownRank > 5;

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="PuzzleArena session header">
        <div>
          <p className="eyebrow">PuzzleArena</p>
          <h1>Live chess puzzle battle</h1>
        </div>
        <div className="room-card">
          <span>Room</span>
          <strong>J4K9</strong>
          <div className="qr" aria-label="QR code mockup">
            {Array.from({ length: 25 }).map((_, index) => <i key={index} className={index % 3 === 0 || index % 7 === 0 ? "on" : ""} />)}
          </div>
        </div>
      </section>

      <nav className="view-tabs" aria-label="Role view">
        {(["admin", "player", "tv"] as View[]).map((role) => (
          <button key={role} className={view === role ? "active" : ""} onClick={() => setView(role)}>
            {role === "admin" ? "Host" : role === "player" ? "Player" : "TV"}
          </button>
        ))}
      </nav>

      {status === "results" ? (
        <Results ranked={ranked} onExport={exportCsv} />
      ) : (
        <div className={`workspace ${view}`}>
          {(view === "admin" || view === "player") && (
            <section className="board-panel" aria-label="Current puzzle">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">{puzzle.id} · {puzzle.rating}</p>
                  <h2>{puzzle.title}</h2>
                </div>
                <span className={`status-pill ${status}`}>{status}</span>
              </div>
              <ChessBoard board={puzzle.board} selected={selected} onSelect={setSelected} />
              <div className="puzzle-meta">
                <span>{puzzle.side} to move</span>
                <span>{puzzle.themes.join(" / ")}</span>
              </div>
              {status === "reveal" && (
                <div className="solution">
                  <strong>Solution</strong>
                  <span>{puzzle.moves.join("  ")}</span>
                  <p>{puzzle.note}</p>
                </div>
              )}
            </section>
          )}

          {view === "admin" && (
            <section className="control-panel" aria-label="Host controls">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Host dashboard</p>
                  <h2>Round controls</h2>
                </div>
                <button className="icon-button" onClick={() => setPlayers((list) => [...list, { id: `guest-${list.length}`, name: `Guest ${list.length}`, score: 0, lastScore: 0, previousRank: list.length + 1, connected: true, answered: false, correct: null, solveTime: null, streak: 0, accuracy: [0] }])} aria-label="Add player">+</button>
              </div>

              <div className="control-grid">
                <label>Timer seconds<input type="number" value={timer} min={10} max={180} onChange={(event) => setTimer(Number(event.target.value))} /></label>
                <label>Max points<input type="number" value={maxPoints} min={10} step={10} onChange={(event) => setMaxPoints(Number(event.target.value))} /></label>
                <label>Cutoff rank<input type="number" value={cutoff} min={1} max={players.length} onChange={(event) => setCutoff(Number(event.target.value))} /></label>
                <label>Scoring<select value={curve} onChange={(event) => setCurve(event.target.value as Curve)}><option value="linear">Linear</option><option value="exponential">Exponential</option><option value="quadratic">Quadratic</option><option value="winner">Winner takes all</option><option value="flat">Flat participation</option></select></label>
              </div>

              <div className="button-row">
                <button onClick={() => previewPuzzle(1)}>Preview puzzle</button>
                <button onClick={startRound} className="primary" disabled={status === "live"}>Push puzzle</button>
                <button onClick={() => setStatus("reveal")} disabled={status !== "live"}>Force end</button>
                <button onClick={endSession}>End session</button>
              </div>

              <div className="waiting">Waiting on {players.length - answeredCount} more</div>
              <Roster players={players} setPlayers={setPlayers} />
              <EventLog events={events} />
            </section>
          )}

          {view === "player" && (
            <section className="player-panel" aria-label="Player controls">
              <div className="score-card">
                <span>Your rank</span>
                <strong>#{ownRank}</strong>
                <small>{playerAbove ? `${playerAbove.score - you.score} pts to catch ${playerAbove.name}` : "You are leading"}</small>
              </div>
              <div className="move-entry">
                <label>Move answer<input value={moveText} onChange={(event) => setMoveText(event.target.value)} placeholder={puzzle.answer} disabled={status !== "live" || you.answered} /></label>
                <button className="primary" onClick={() => submitMove()} disabled={status !== "live" || you.answered}>Submit</button>
                <button onClick={() => submitMove(true)} disabled={status !== "live" || you.answered}>Give up</button>
              </div>
              {you.answered && <div className={you.correct ? "feedback correct" : "feedback wrong"}>{you.correct ? `Correct +${you.lastScore}` : "No points this round"}</div>}
              <Leaderboard players={topFive} pinned={showPinnedYou ? you : null} allPlayers={players} />
            </section>
          )}

          {view === "tv" && (
            <section className="tv-panel" aria-label="TV leaderboard">
              <div className="timer-ring">
                <span>{status === "live" ? timeLeft : "Ready"}</span>
                <small>{status === "live" ? "seconds" : "next puzzle"}</small>
              </div>
              <Leaderboard players={ranked} pinned={null} allPlayers={players} large />
            </section>
          )}
        </div>
      )}
    </main>
  );
}

function ChessBoard({ board, selected, onSelect }: { board: string[]; selected: number | null; onSelect: (index: number) => void }) {
  return (
    <div className="board" role="grid" aria-label="Chess puzzle board">
      {board.map((piece, index) => {
        const file = index % 8;
        const rank = Math.floor(index / 8);
        return (
          <button
            key={index}
            className={`${(file + rank) % 2 === 0 ? "light" : "dark"} ${selected === index ? "selected" : ""} ${piece ? "occupied" : ""}`}
            onClick={() => onSelect(index)}
            aria-label={piece ? `Piece ${piece}` : "Empty square"}
          >
            {piece}
          </button>
        );
      })}
    </div>
  );
}

function Leaderboard({ players, pinned, allPlayers, large = false }: { players: Player[]; pinned: Player | null; allPlayers: Player[]; large?: boolean }) {
  return (
    <div className={`leaderboard ${large ? "large" : ""}`}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Live standings</p>
          <h2>Leaderboard</h2>
        </div>
      </div>
      {[...players, ...(pinned ? [pinned] : [])].map((player) => {
        const rank = rankOf(allPlayers, player.id);
        const delta = player.previousRank - rank;
        return (
          <div className={`leader-row ${player.id === "you" ? "you" : ""}`} key={player.id}>
            <span className="rank">#{rank}</span>
            <span className="avatar">{player.name.slice(0, 1)}</span>
            <span className="name">{player.name}</span>
            <strong>{player.score}</strong>
            <span className={delta > 0 ? "up" : delta < 0 ? "down" : "flat"}>{delta > 0 ? `+${delta}` : delta}</span>
          </div>
        );
      })}
    </div>
  );
}

function Roster({ players, setPlayers }: { players: Player[]; setPlayers: React.Dispatch<React.SetStateAction<Player[]>> }) {
  return (
    <div className="roster">
      <p className="eyebrow">Roster</p>
      {players.map((player) => (
        <div className="roster-row" key={player.id}>
          <span className={player.connected ? "dot on" : "dot"} />
          <strong>{player.name}</strong>
          <span>{player.answered ? "answered" : "thinking"}</span>
          <button onClick={() => setPlayers((list) => list.map((item) => item.id === player.id ? { ...item, muted: !item.muted } : item))}>{player.muted ? "Unmute" : "Mute"}</button>
        </div>
      ))}
    </div>
  );
}

function EventLog({ events }: { events: string[] }) {
  return (
    <div className="event-log">
      <p className="eyebrow">Session log</p>
      {events.map((event, index) => <span key={`${event}-${index}`}>{event}</span>)}
    </div>
  );
}

function Results({ ranked, onExport }: { ranked: Player[]; onExport: () => void }) {
  const podium = ranked.slice(0, 3);
  return (
    <section className="results" aria-label="Final results">
      <div className="results-heading">
        <p className="eyebrow">Final results</p>
        <h2>{podium[0]?.name} wins PuzzleArena</h2>
        <button className="primary" onClick={onExport}>Export CSV</button>
      </div>
      <div className="podium">
        {[podium[2], podium[1], podium[0]].filter(Boolean).map((player, index) => (
          <div className={`podium-card place-${index}`} key={player.id}>
            <span>#{ranked.findIndex((item) => item.id === player.id) + 1}</span>
            <strong>{player.name}</strong>
            <em>{player.score} pts</em>
          </div>
        ))}
      </div>
      <div className="standings">
        {ranked.map((player, index) => {
          const accuracy = Math.round((player.accuracy.reduce((sum, value) => sum + value, 0) / player.accuracy.length) * 100);
          return (
            <div className="leader-row" key={player.id}>
              <span className="rank">#{index + 1}</span>
              <span className="avatar">{player.name.slice(0, 1)}</span>
              <span className="name">{player.name}</span>
              <strong>{player.score}</strong>
              <span>{accuracy}%</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
