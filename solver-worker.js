/**
 * Connect Four Solver — Web Worker
 * Runs in a background thread so the UI never freezes.
 *
 * Board sizes: 8×9, 9×8, 9×9, 10×10
 * All bitboards use BigInt (boards need up to 110 bits).
 *
 * Algorithm: negamax + alpha-beta + transposition table (upper bounds) +
 *            non-losing-move pruning + centre-first column order +
 *            null-window binary search.
 *
 * Messages IN  (from main thread):
 *   { cmd:'score_moves', moves:[...], W, H }
 *   { cmd:'suggest',     moves:[...], W, H }
 *   { cmd:'solve',       moves:[...], W, H }   ← single exact score
 *   { cmd:'cancel' }
 *
 * Messages OUT (to main thread):
 *   { type:'score_moves', scores:{col:score,...}, nodes, ms }
 *   { type:'suggest',     col, score, nodes, ms }
 *   { type:'solve',       score, nodes, ms }
 *   { type:'progress',    nodes }               ← periodic during long solve
 *   { type:'error',       msg }
 *   { type:'cancelled' }
 */

'use strict';

// ── BigInt constants ──────────────────────────────────────────────────────────
const B0 = 0n;
const B1 = 1n;

// ── Board-constant cache ──────────────────────────────────────────────────────
const _bcCache = {};

function getBoardConstants(W, H) {
  const key = `${W}x${H}`;
  if (_bcCache[key]) return _bcCache[key];
  const H1 = H + 1;
  const bH1 = BigInt(H1);
  const bH  = BigInt(H);

  let bot = B0, board = B0;
  const top = [], col = [];
  for (let c = 0; c < W; c++) {
    const base = BigInt(c) * bH1;
    bot   |= B1 << base;
    board |= ((B1 << bH) - B1) << base;
    top.push(B1 << (base + bH - B1));
    col.push(((B1 << bH) - B1) << base);
  }

  // Centre-first column order
  const order = Array.from({length: W}, (_, i) => i)
    .sort((a, b) => Math.abs(a - (W-1)/2) - Math.abs(b - (W-1)/2));

  const bc = { W, H, H1, bH1, bot, board, top, col, order };
  _bcCache[key] = bc;
  return bc;
}

// ── Position ──────────────────────────────────────────────────────────────────
class Position {
  constructor(bc, pos = B0, mask = B0, moves = 0) {
    this.bc    = bc;
    this.pos   = pos;
    this.mask  = mask;
    this.moves = moves;
  }

  _next(c) {
    const { col, mask } = this;
    const empty = this.bc.col[c] & ~mask;
    return empty & -empty;           // lowest set bit = next empty cell
  }

  canPlay(c) {
    return (this.mask & this.bc.top[c]) === B0;
  }

  isWinningMove(c) {
    return this._align4(this.pos | this._next(c));
  }

  play(c) {
    return new Position(
      this.bc,
      this.mask ^ this.pos,           // opponent becomes current
      this.mask | this._next(c),
      this.moves + 1
    );
  }

  opponentJustWon() {
    return this._align4(this.mask ^ this.pos);
  }

  _align4(b) {
    const { H1 } = this.bc;
    const bH1 = this.bc.bH1;
    for (const s of [1n, bH1, bH1 - 1n, bH1 + 1n]) {
      const m = b & (b >> s);
      if ((m & (m >> (s * 2n))) !== B0) return true;
    }
    return false;
  }

  _winPositions(p) {
    const { bH1, board, mask } = this.bc;
    let r = B0;

    // Vertical (shift=1): only _XXX pattern needed (can't float)
    r |= (p << 1n) & (p << 2n) & (p << 3n);

    for (const s of [bH1, bH1 + 1n, bH1 - 1n]) {
      const s2 = s * 2n, s3 = s * 3n;
      let q  = (p << s) & (p << s2);
      r |= q & (p << s3);    // _XXX
      r |= q & (p >> s);     // X_XX
          q  = (p >> s) & (p >> s2);
      r |= q & (p >> s3);    // XXX_
      r |= q & (p << s);     // XX_X
    }

    return r & (board ^ this.mask);   // only empty valid cells
  }

  _playable() {
    const { bot, board } = this.bc;
    return (this.mask + bot) & board;
  }

  winPositionsCurrent() { return this._winPositions(this.pos); }

  nonLosingMoves() {
    const possible = this._playable();
    const oppWins  = this._winPositions(this.mask ^ this.pos);
    const forced   = possible & oppWins;
    if (forced !== B0) {
      if ((forced & (forced - B1)) !== B0) return B0;  // >1 forced → doomed
      return forced & ~(oppWins >> 1n);
    }
    return possible & ~(oppWins >> 1n);
  }

  winScore() {
    return Math.floor((this.bc.W * this.bc.H + 1 - this.moves) / 2);
  }

  key() {
    return this.pos + this.mask + this.bc.bot;
  }
}

// ── Transposition Table ───────────────────────────────────────────────────────
class TT {
  constructor(bits = 22) {
    this.n   = 1 << bits;
    this.off = 0;   // set per Solver
    // Store keys as BigInt strings for exact matching; vals as Numbers
    this.keys = new Array(this.n).fill(null);
    this.vals = new Int32Array(this.n);  // 0 = empty (after offset)
  }

  setOffset(off) { this.off = off; }

  get(key) {
    const i = Number(key % BigInt(this.n));
    if (this.keys[i] === key && this.vals[i] !== 0)
      return this.vals[i] - this.off;
    return null;
  }

  put(key, val) {
    const i = Number(key % BigInt(this.n));
    this.keys[i] = key;
    this.vals[i] = val + this.off;
  }

  reset() {
    this.keys.fill(null);
    this.vals.fill(0);
  }
}

// ── Opening Book (IndexedDB) ──────────────────────────────────────────────────
class OpeningBook {
  constructor(W, H, maxMoves = 30) {
    this.dbName   = `c4book_${W}x${H}`;
    this.maxMoves = maxMoves;
    this.db       = null;
    this._pending = [];
    this.BATCH    = 100;
  }

  async open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('positions');
      };
      req.onsuccess = e => { this.db = e.target.result; res(); };
      req.onerror   = () => rej(req.error);
    });
  }

  async get(key) {
    if (!this.db) return null;
    return new Promise((res) => {
      const tx  = this.db.transaction('positions', 'readonly');
      const req = tx.objectStore('positions').get(String(key));
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => res(null);
    });
  }

  async put(key, score, moves) {
    if (!this.db || moves > this.maxMoves) return;
    this._pending.push([String(key), score]);
    if (this._pending.length >= this.BATCH) await this.flush();
  }

  async flush() {
    if (!this.db || this._pending.length === 0) return;
    const batch = this._pending.splice(0);
    return new Promise((res) => {
      const tx    = this.db.transaction('positions', 'readwrite');
      const store = tx.objectStore('positions');
      for (const [k, v] of batch) store.put(v, k);
      tx.oncomplete = res;
      tx.onerror    = res;
    });
  }

  async size() {
    if (!this.db) return 0;
    return new Promise((res) => {
      const tx  = this.db.transaction('positions', 'readonly');
      const req = tx.objectStore('positions').count();
      req.onsuccess = () => res(req.result);
      req.onerror   = () => res(0);
    });
  }
}

// ── Solver ────────────────────────────────────────────────────────────────────
class Solver {
  constructor(W, H, ttBits = 22) {
    this.bc      = getBoardConstants(W, H);
    this.W = W; this.H = H;
    this.off     = W * H + 2;
    this.tt      = new TT(ttBits);
    this.tt.setOffset(this.off);
    this.nodes   = 0;
    this._cancel = false;
    this.book    = null;
  }

  async attachBook(W, H, maxMoves = 30) {
    this.book = new OpeningBook(W, H, maxMoves);
    try { await this.book.open(); } catch { this.book = null; }
  }

  cancel() { this._cancel = true; }

  reset() { this.tt.reset(); this.nodes = 0; this._cancel = false; }

  _makePos(moves) {
    let pos = new Position(this.bc);
    for (const c of moves) {
      if (!pos.canPlay(c)) throw new Error(`Column ${c} is full`);
      pos = pos.play(c);
    }
    return pos;
  }

  async solve(pos) {
    // Book lookup
    if (this.book) {
      const cached = await this.book.get(pos.key());
      if (cached !== null) return cached;
    }

    const WH = this.W * this.H;
    let lo = -Math.floor((WH - pos.moves) / 2);
    let hi =  Math.floor((WH + 1 - pos.moves) / 2);

    while (lo < hi) {
      let mid = lo + Math.floor((hi - lo) / 2);
      if (mid <= 0 && Math.floor(lo / 2) < mid)       mid = Math.floor(lo / 2);
      else if (mid >= 0 && Math.floor(hi / 2) > mid)  mid = Math.floor(hi / 2);

      const r = this._negamax(pos, mid, mid + 1);
      if (r === null) return null;   // cancelled
      if (r <= mid) hi = r; else lo = r;
    }

    if (this.book) await this.book.put(pos.key(), lo, pos.moves);
    return lo;
  }

  _negamax(pos, alpha, beta) {
    if (this._cancel) return null;

    this.nodes++;
    if (this.nodes % 50000 === 0) {
      postMessage({ type: 'progress', nodes: this.nodes });
    }

    const WH = this.W * this.H;
    if (pos.moves === WH) return 0;

    if ((pos.winPositionsCurrent() & pos._playable()) !== B0)
      return pos.winScore();

    const upper = Math.floor((WH - 1 - pos.moves) / 2);
    if (beta > upper) {
      beta = upper;
      if (alpha >= beta) return beta;
    }

    const cached = this.tt.get(pos.key());
    if (cached !== null && cached < beta) {
      beta = cached;
      if (alpha >= beta) return beta;
    }

    const moves = pos.nonLosingMoves();
    if (moves === B0) return -Math.floor((WH - pos.moves) / 2);

    for (const c of this.bc.order) {
      if (!pos.canPlay(c)) continue;
      if ((moves & pos._next(c)) === B0) continue;

      const score = this._negamax(pos.play(c), -beta, -alpha);
      if (score === null) return null;

      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }

    this.tt.put(pos.key(), alpha);
    return alpha;
  }

  async scoreMoves(moves) {
    const pos     = this._makePos(moves);
    const results = {};
    const W       = this.W;

    for (let c = 0; c < W; c++) {
      if (!pos.canPlay(c)) continue;
      if (pos.isWinningMove(c)) {
        results[c] = pos.winScore();
      } else {
        const s = await this.solve(pos.play(c));
        if (s === null) return null;   // cancelled
        results[c] = -s;
      }
    }
    if (this.book) await this.book.flush();
    return results;
  }

  async suggestMove(moves) {
    const scores = await this.scoreMoves(moves);
    if (!scores) return null;

    const wins = Object.entries(scores).filter(([,s]) => s > 0);
    if (wins.length) {
      const total = wins.reduce((a, [,s]) => a + s, 0);
      let r = Math.random() * total;
      for (const [c, s] of wins) { r -= s; if (r <= 0) return [+c, s]; }
      return [+wins[wins.length-1][0], wins[wins.length-1][1]];
    }

    const best = Math.max(...Object.values(scores));
    const tied = Object.keys(scores).filter(c => scores[c] === best);
    const c    = +tied[Math.floor(Math.random() * tied.length)];
    return [c, scores[c]];
  }
}

// ── Worker message handler ────────────────────────────────────────────────────
let solver = null;

self.onmessage = async (e) => {
  const { cmd, moves, W, H, ttBits, bookEnabled, bookMaxMoves } = e.data;

  if (cmd === 'cancel') {
    if (solver) solver.cancel();
    postMessage({ type: 'cancelled' });
    return;
  }

  if (cmd === 'init') {
    solver = new Solver(W, H, ttBits ?? 21);
    if (bookEnabled) await solver.attachBook(W, H, bookMaxMoves ?? 30);
    const bookSize = solver.book ? await solver.book.size() : 0;
    postMessage({ type: 'ready', bookSize });
    return;
  }

  if (!solver || solver.W !== W || solver.H !== H) {
    solver = new Solver(W, H, 21);
    if (e.data.bookEnabled) await solver.attachBook(W, H, e.data.bookMaxMoves ?? 30);
  } else {
    solver.reset();
  }

  const t0 = performance.now();

  try {
    if (cmd === 'score_moves') {
      const scores = await solver.scoreMoves(moves);
      if (scores === null) { postMessage({ type: 'cancelled' }); return; }
      postMessage({ type: 'score_moves', scores,
        nodes: solver.nodes, ms: performance.now() - t0 });

    } else if (cmd === 'suggest') {
      const res = await solver.suggestMove(moves);
      if (res === null) { postMessage({ type: 'cancelled' }); return; }
      postMessage({ type: 'suggest', col: res[0], score: res[1],
        nodes: solver.nodes, ms: performance.now() - t0 });

    } else if (cmd === 'solve') {
      const pos   = solver._makePos(moves);
      const score = await solver.solve(pos);
      if (score === null) { postMessage({ type: 'cancelled' }); return; }
      postMessage({ type: 'solve', score,
        nodes: solver.nodes, ms: performance.now() - t0 });
    }
  } catch (err) {
    postMessage({ type: 'error', msg: err.message });
  }
};
