'use strict';
// 라이어 게임 v0.1 — 서버가 모든 게임 상태를 결정합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const WORDS = require('./words');

const PORT = Number(process.env.PORT) || 3000;
// 리버스 프록시(nginx/Caddy) 뒤에서 돌릴 때는 HOST=127.0.0.1 로 외부 직접 접속을 막습니다.
const HOST = process.env.HOST || '0.0.0.0';
// 예: ALLOWED_ORIGINS=https://liar.example.com  (비우면 검사하지 않음)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
// 테스트용: LIAR_TIME_SCALE=0.05 이면 모든 제한 시간이 1/20로 줄어듭니다.
const SCALE = Number(process.env.LIAR_TIME_SCALE) || 1;
const sec = (s) => Math.max(50, Math.round(s * 1000 * SCALE));
const TIMES = {
  role: sec(10),
  hint: sec(20),
  discussion: sec(60),
  vote: sec(20),
  revote: sec(15),
  defense: sec(10), // 최다 득표자의 최후의 변론
  confirm: sec(5),  // 지목 확정 찬반 투표
  guess: sec(20),
  grace: sec(60),
};
const DISCUSSION_MIN_LEFT = sec(10); // 모두 줄이기를 눌러도 남는 최소 토론 시간
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MAX_SPECTATORS = 20; // 참가자 10명과 별도
const CHAT_MAX = 200;
const HINT_MAX = 100;
const NICK_MAX = 12;
const GUESS_MAX = 30;
const CHAT_HISTORY = 200;
// 승리 점수 (방장이 대기실·결과 화면에서 0~10점으로 바꿀 수 있음)
const DEFAULT_POINTS = { citizenWin: 1, liarWin: 3 };
const POINTS_MAX = 10;
const CHAT_PHASES = new Set(['lobby', 'discussion', 'defense', 'result']); // defense는 지목된 사람만
const ROUND_PHASES = new Set(['role', 'hint', 'discussion', 'vote', 'revote', 'defense', 'confirm', 'guess']);
const PHASE_LABEL = {
  lobby: '대기실', role: '역할 확인', hint: '힌트 발표', discussion: '토론',
  vote: '투표', revote: '재투표', defense: '최후의 변론', confirm: '찬반 투표',
  guess: '라이어의 추측', result: '결과',
};

// 이모지 반응: 이 목록에 있는 것만 중계합니다 (클라이언트도 입장 시 이 목록을 받아 버튼을 그림)
const EMOJIS = [
  '😂', '🤣', '😆', '🥳', '🎉', '👏', // 웃음·신남
  '😮', '😱', '🤯', '😳',             // 놀람·충격
  '🤔', '🧐', '🤨', '😏', '🕵️', '👀', // 의심·추리
  '😡', '🤬', '🙄', '😤',             // 화남·답답
  '😭', '🥲', '🙏', '😇',             // 억울·결백
  '👍', '👎', '❤️', '🔥', '💯', '💀', '🤡', '🤫', '🫣', '😴',
];
const EMOJI_SET = new Set(EMOJIS);
// 연타는 허용하되 한 사람이 서버·다른 브라우저를 마비시키지 못하게 토큰 버킷으로 제한
const REACT_BURST = 20;   // 한 번에 몰아칠 수 있는 개수
const REACT_PER_SEC = 12; // 초당 회복량

// 방 이름을 비우면 붙는 물고기 이름
const ROOM_NAME_MAX = 20;
const FISH = [
  '고등어', '연어', '참치', '광어', '우럭', '갈치', '꽁치', '삼치', '방어', '도미',
  '농어', '숭어', '복어', '아귀', '전갱이', '정어리', '멸치', '청어', '대구', '명태',
  '가자미', '쥐치', '볼락', '붕어', '잉어', '메기', '송어', '빙어', '쏘가리', '금붕어',
  '개복치', '흰동가리', '블루탱', '가오리', '철갑상어', '망둥어', '장어', '꺽지', '피라미', '열빙어',
];

const rooms = new Map();
let joinSeq = 0;

// 지금 열려 있는 방 이름과 겹치지 않는 물고기 이름을 고릅니다.
function fishName() {
  const used = new Set([...rooms.values()].map((r) => r.name));
  const free = FISH.filter((f) => !used.has(f));
  if (free.length) return pick(free);
  const base = pick(FISH);
  let n = 2;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// ---------- 로비(첫 화면)의 열린 방 목록 ----------
// 아직 방에 들어가지 않은 연결 중 목록을 요청한 연결에만 보냅니다.
const lobbyWatchers = new Set();
let lobbyTimer = null;
function roomSummary(room) {
  const host = room.players.get(room.hostId);
  return {
    code: room.code,
    name: room.name,
    host: host ? host.nickname : null,
    players: activePlayers(room).length,
    maxPlayers: MAX_PLAYERS,
    spectators: spectatorList(room).length,
    maxSpectators: MAX_SPECTATORS,
    phase: room.phase,
    inProgress: ROUND_PHASES.has(room.phase),
    roundNo: room.roundNo,
  };
}
function roomList() {
  return [...rooms.values()]
    .map((r) => [r, roomSummary(r)])
    // 바로 참가할 수 있는 방을 먼저, 그다음 최근에 만든 방 순
    .sort(([ra, a], [rb, b]) => {
      const ja = !a.inProgress && a.players < a.maxPlayers;
      const jb = !b.inProgress && b.players < b.maxPlayers;
      return ja !== jb ? (ja ? -1 : 1) : rb.createdAt - ra.createdAt;
    })
    .slice(0, 100)
    .map(([, s]) => s);
}
function sendRoomList(ws) { send(ws, { t: 'rooms', rooms: roomList() }); }
// 방 상태가 바뀔 때마다 부르되, 0.25초에 한 번으로 묶어서 보냅니다.
function scheduleLobby() {
  if (lobbyTimer || lobbyWatchers.size === 0) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    const data = JSON.stringify({ t: 'rooms', rooms: roomList() });
    for (const ws of lobbyWatchers) if (ws.readyState === 1) ws.send(data);
  }, 250);
}

// ---------- 유틸 ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32자, 헷갈리는 0/O/1/I 제외
function makeCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  } while (rooms.has(code));
  return code;
}
const pick = (arr) => arr[crypto.randomInt(arr.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const normalize = (s) => String(s).normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const cleanLine = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const answers = (r) => [r.word, ...r.aliases];

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendTo(p, obj) { send(p.ws, obj); }
const byJoin = (a, b) => a.joinedAt - b.joinedAt;
// 게임에 참여하는 사람(관전자 제외), 입장 순
const activePlayers = (room) => [...room.players.values()].filter((p) => !p.spectator).sort(byJoin);
const spectatorList = (room) => [...room.players.values()].filter((p) => p.spectator).sort(byJoin);

// 방장은 항상 관전자가 아닌 참가자 중에서, 입장이 가장 빠른 사람으로 둡니다.
function ensureHost(room) {
  const cur = room.players.get(room.hostId);
  if (cur && !cur.spectator) return;
  const next = activePlayers(room)[0];
  room.hostId = next ? next.id : null;
  if (next) system(room, `${next.nickname}님이 새 방장이 되었습니다.`);
}
function err(ws, message, code) { send(ws, { t: 'error', message, code }); }

// ---------- 채팅 ----------
function addChat(room, msg) {
  msg.id = ++room.msgSeq;
  msg.ts = Date.now();
  room.chat.push(msg);
  if (room.chat.length > CHAT_HISTORY) room.chat.shift();
  for (const p of room.players.values()) sendTo(p, { t: 'chat', msg });
}
const system = (room, text) => addChat(room, { kind: 'system', text });

// ---------- 상태 전송 (참가자별로 공개 범위를 다르게) ----------
function viewFor(room, me) {
  const r = room.round;
  const phase = room.phase;
  const players = activePlayers(room).map((p) => ({
    id: p.id,
    nickname: p.nickname,
    score: p.score,
    connected: p.connected,
    inRound: !!(r && r.participants.includes(p.id)),
  }));
  const spectators = spectatorList(room).map((p) => ({
    id: p.id, nickname: p.nickname, score: p.score, connected: p.connected,
  }));
  let round = null;
  if (r) {
    const inRound = r.participants.includes(me.id);
    const reveal = phase === 'result';
    const isLiar = me.id === r.liarId;
    const voteMap = phase === 'revote' ? r.revotes : phase === 'confirm' ? r.confirms : r.votes;
    const voting = phase === 'vote' || phase === 'revote' || phase === 'confirm';
    round = {
      no: r.no,
      topic: r.topic,
      role: inRound ? (isLiar ? 'liar' : 'citizen') : 'spectator',
      // 제시어는 결과 공개 전까지 시민에게만 보냅니다.
      word: reveal || (inRound && !isLiar) ? r.word : null,
      names: r.names,
      order: r.order,
      turn: r.turn,
      hints: r.hints,
      timeVotes: r.timeVotes,
      timeStep: Math.floor(TIMES.discussion / r.participants.length),
      voted: voting ? [...voteMap.keys()] : [],
      // confirm 단계에서는 true(찬성)/false(반대)
      myVote: voting ? voteMap.get(me.id) ?? null : null,
      candidates: phase === 'revote' ? r.candidates : null,
      accusedId: ['defense', 'confirm', 'guess', 'result'].includes(phase) ? r.accusedId : null,
      result: reveal ? r.result : null,
    };
    if (reveal) {
      round.liarId = r.liarId;
      round.aliases = r.aliases;
    }
  }
  return {
    t: 'state',
    serverNow: Date.now(),
    me: me.id,
    meSpectator: !!me.spectator,
    code: room.code,
    roomName: room.name,
    hostId: room.hostId,
    phase,
    deadline: room.deadline,
    duration: room.duration,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    maxSpectators: MAX_SPECTATORS,
    settings: room.settings,
    pointsMax: POINTS_MAX,
    players,
    spectators,
    round,
  };
}
function broadcastState(room) {
  for (const p of room.players.values()) sendTo(p, viewFor(room, p));
  scheduleLobby(); // 인원·단계가 바뀌었을 수 있으니 로비 목록도 갱신
}

// ---------- 단계 전환 ----------
function clearPhaseTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}
function armTimer(room, ms) {
  if (room.timer) clearTimeout(room.timer);
  const onTimeout = room.onTimeout;
  room.timer = setTimeout(() => {
    room.timer = null;
    onTimeout();
  }, Math.max(0, ms));
}

function setPhase(room, phase, ms, onTimeout, announce = true) {
  clearPhaseTimer(room);
  room.phase = phase;
  room.duration = ms || null;
  room.deadline = ms ? Date.now() + ms : null;
  room.onTimeout = onTimeout || null; // 시간 단축 시 타이머를 다시 걸 때 사용
  if (ms && onTimeout) armTimer(room, ms);
  if (announce) system(room, `${PHASE_LABEL[phase]} 단계가 시작되었습니다.`);
  broadcastState(room);
}

function startRound(room, p, ws) {
  if (room.hostId !== p.id) return err(ws, '방장만 라운드를 시작할 수 있어요.');
  if (room.phase !== 'lobby' && room.phase !== 'result') return err(ws, '이미 라운드가 진행 중이에요.');
  const ps = activePlayers(room); // 관전자는 라운드에 참여하지 않습니다.
  if (ps.length < MIN_PLAYERS) return err(ws, `${MIN_PLAYERS}명 이상 모여야 시작할 수 있어요.`);
  if (ps.some((x) => !x.connected)) return err(ws, '연결이 끊긴 참가자가 있어요. 재접속하거나 퇴장 처리될 때까지 기다려 주세요.');

  // 같은 방에서 이미 나온 제시어는 다 쓸 때까지 다시 고르지 않습니다.
  let pool = [];
  for (const t of WORDS) for (const w of t.words) if (!room.usedWords.has(w.word)) pool.push({ topic: t.topic, ...w });
  if (pool.length === 0) {
    room.usedWords.clear();
    for (const t of WORDS) for (const w of t.words) pool.push({ topic: t.topic, ...w });
  }
  const chosen = pick(pool);
  room.usedWords.add(chosen.word);

  const participants = ps.map((x) => x.id);
  room.roundNo += 1;
  room.round = {
    no: room.roundNo,
    topic: chosen.topic,
    word: chosen.word,
    aliases: chosen.aliases,
    liarId: pick(participants),
    participants,
    order: shuffle(participants),
    names: Object.fromEntries(ps.map((x) => [x.id, x.nickname])),
    points: { ...room.settings }, // 라운드 시작 시점의 점수 규칙으로 고정
    turn: -1,
    hints: [],
    votes: new Map(),
    revotes: new Map(),
    confirms: new Map(),
    confirmTally: null,
    timeVotes: {}, // 참가자 id → 'cut'(줄이기) | 'add'(늘리기)
    candidates: null,
    firstTally: null,
    revoteTally: null,
    accusedId: null,
    guess: null,
    guessUsed: false,
    result: null,
  };
  system(room, `라운드 ${room.roundNo}을(를) 시작합니다. 참가자 ${participants.length}명.`);
  setPhase(room, 'role', TIMES.role, () => hintTurn(room, 0, true));
}

function hintTurn(room, idx, announce) {
  const r = room.round;
  r.turn = idx;
  if (idx >= r.order.length) {
    setPhase(room, 'discussion', TIMES.discussion, () => startVote(room));
    return;
  }
  setPhase(room, 'hint', TIMES.hint, () => {
    // 시간 안에 제출하지 않으면 차례가 넘어갑니다.
    r.hints.push({ order: idx + 1, playerId: r.order[idx], text: null });
    hintTurn(room, idx + 1, false);
  }, announce);
}

function containsWord(text, r) {
  const n = normalize(text);
  return answers(r).some((w) => {
    const nw = normalize(w);
    return nw.length >= 2 || w === r.word ? n.includes(nw) : false;
  });
}

function submitHint(room, p, ws, raw) {
  const r = room.round;
  if (room.phase !== 'hint') return err(ws, '지금은 힌트를 낼 수 없어요.');
  if (r.order[r.turn] !== p.id) return err(ws, '지금은 내 차례가 아니에요.');
  const text = cleanLine(raw);
  if (!text) return err(ws, '힌트를 입력해 주세요.');
  if (text.length > HINT_MAX) return err(ws, `힌트는 ${HINT_MAX}자 이내로 써 주세요.`);
  // 시민만 검사합니다. 라이어에게 거절 메시지를 보내면 제시어가 새어 나가기 때문입니다.
  if (p.id !== r.liarId && containsWord(text, r)) return err(ws, '제시어(또는 그 별칭)를 그대로 말할 수는 없어요.');
  r.hints.push({ order: r.turn + 1, playerId: p.id, text });
  hintTurn(room, r.turn + 1, false);
}

// 토론 시간 조절: 참가자마다 라운드당 한 번, 줄이기(cut)나 늘리기(add) 중 하나만.
// 한 번에 (토론 시간 ÷ 참가자 수)만큼 바뀌고, 모두 줄여도 최소 DISCUSSION_MIN_LEFT(10초)는 남습니다.
function adjustDiscussion(room, p, ws, dir) {
  const r = room.round;
  if (dir !== 'cut' && dir !== 'add') return err(ws, '알 수 없는 요청이에요.');
  if (room.phase !== 'discussion') return err(ws, '토론 중에만 시간을 줄이거나 늘릴 수 있어요.');
  if (!r.participants.includes(p.id)) return err(ws, '이번 라운드 참가자만 토론 시간을 바꿀 수 있어요.');
  if (r.timeVotes[p.id]) return err(ws, '토론 시간 줄이기·늘리기는 둘 중 하나만, 한 번만 누를 수 있어요.');
  const now = Date.now();
  const step = Math.floor(TIMES.discussion / r.participants.length);
  const floor = now + DISCUSSION_MIN_LEFT;
  if (dir === 'cut' && room.deadline <= floor) {
    // 선택권은 쓰지 않은 것으로 둡니다 (늘리기는 여전히 가능)
    return err(ws, `남은 시간이 ${Math.round(DISCUSSION_MIN_LEFT / 1000 / SCALE)}초 이하라 더 줄일 수 없어요.`);
  }
  r.timeVotes[p.id] = dir;
  const before = room.deadline;
  room.deadline = dir === 'cut' ? Math.max(before - step, floor) : before + step;
  const changed = Math.abs(room.deadline - before);
  const secs = Math.round(changed / 1000 / SCALE);
  system(room, `${p.nickname}님이 토론 시간을 ${secs}초 ${dir === 'cut' ? '줄였어요' : '늘렸어요'}.`
    + (dir === 'cut' && room.deadline === floor ? ` (최소 ${Math.round(DISCUSSION_MIN_LEFT / 1000 / SCALE)}초는 남아요)` : ''));
  const left = room.deadline - now;
  if (left > room.duration) room.duration = left; // 늘어난 만큼 타이머 막대도 기준을 키움
  armTimer(room, left);
  broadcastState(room);
}

function startVote(room) {
  room.round.votes = new Map();
  setPhase(room, 'vote', TIMES.vote, () => tallyFirst(room));
}

function tally(map) {
  const counts = {};
  for (const target of map.values()) counts[target] = (counts[target] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  const tops = max > 0 ? Object.keys(counts).filter((id) => counts[id] === max) : [];
  return { counts, tops };
}

function castVote(room, p, ws, targetId) {
  const r = room.round;
  if (room.phase !== 'vote' && room.phase !== 'revote') return err(ws, '지금은 투표 시간이 아니에요.');
  if (!r.participants.includes(p.id)) return err(ws, '이번 라운드 참가자만 투표할 수 있어요.');
  const map = room.phase === 'vote' ? r.votes : r.revotes;
  if (map.has(p.id)) return err(ws, '이미 투표했어요. 투표는 바꿀 수 없어요.');
  if (targetId === p.id) return err(ws, '자기 자신에게는 투표할 수 없어요.');
  const allowed = room.phase === 'vote' ? r.participants : r.candidates;
  if (!allowed.includes(targetId)) return err(ws, '투표할 수 없는 대상이에요.');
  map.set(p.id, targetId);
  if (map.size >= r.participants.length) {
    // 모두 투표하면 즉시 집계합니다.
    room.phase === 'vote' ? tallyFirst(room) : tallyRevote(room);
  } else {
    broadcastState(room);
  }
}

function tallyFirst(room) {
  clearPhaseTimer(room);
  const r = room.round;
  const { counts, tops } = tally(r.votes);
  r.firstTally = counts;
  if (r.votes.size === 0) return finish(room, 'liar', 'allAbstain');
  if (tops.length === 1) return accuse(room, tops[0]);
  r.candidates = tops;
  r.revotes = new Map();
  system(room, `최다 득표 동률: ${tops.map((id) => r.names[id]).join(', ')}. 이 후보들만 대상으로 재투표합니다.`);
  setPhase(room, 'revote', TIMES.revote, () => tallyRevote(room));
}

function tallyRevote(room) {
  clearPhaseTimer(room);
  const r = room.round;
  const { counts, tops } = tally(r.revotes);
  r.revoteTally = counts;
  if (r.revotes.size === 0) return finish(room, 'liar', 'revoteNoVotes');
  if (tops.length > 1) return finish(room, 'liar', 'revoteTie');
  accuse(room, tops[0]);
}

// 최다 득표자 → 최후의 변론(지목된 사람만 채팅) → 찬반 투표
function accuse(room, id) {
  const r = room.round;
  r.accusedId = id;
  system(room, `${r.names[id]}님이 최다 득표했습니다. ${Math.round(TIMES.defense / 1000 / SCALE)}초 동안 최후의 변론을 들어 보세요.`);
  setPhase(room, 'defense', TIMES.defense, () => startConfirm(room));
}

function startConfirm(room) {
  room.round.confirms = new Map();
  setPhase(room, 'confirm', TIMES.confirm, () => tallyConfirm(room));
}

function castConfirm(room, p, ws, agree) {
  const r = room.round;
  if (room.phase !== 'confirm') return err(ws, '지금은 찬반 투표 시간이 아니에요.');
  if (!r.participants.includes(p.id)) return err(ws, '이번 라운드 참가자만 투표할 수 있어요.');
  if (p.id === r.accusedId) return err(ws, '지목된 사람은 찬반 투표에 참여할 수 없어요.');
  if (r.confirms.has(p.id)) return err(ws, '이미 투표했어요. 투표는 바꿀 수 없어요.');
  r.confirms.set(p.id, !!agree);
  if (r.confirms.size >= r.participants.length - 1) tallyConfirm(room);
  else broadcastState(room);
}

function tallyConfirm(room) {
  clearPhaseTimer(room);
  const r = room.round;
  let yes = 0, no = 0;
  for (const v of r.confirms.values()) v ? yes++ : no++;
  r.confirmTally = { yes, no };
  // 찬성이 반대보다 많아야 지목 확정. 동수·반대 우세·전원 기권이면 부결 → 라이어 승리
  if (yes > no) return resolveAccused(room);
  system(room, `찬반 투표 부결 (찬성 ${yes} · 반대 ${no}). ${r.names[r.accusedId]}님은 지목되지 않았습니다.`);
  finish(room, 'liar', 'acquitted');
}

function resolveAccused(room) {
  const r = room.round;
  const id = r.accusedId;
  if (id !== r.liarId) return finish(room, 'liar', 'citizenAccused');
  system(room, `${r.names[id]}님이 지목되었고, 라이어였습니다! 라이어가 제시어를 추측합니다.`);
  setPhase(room, 'guess', TIMES.guess, () => finish(room, 'citizen', 'guessTimeout'));
}

function submitGuess(room, p, ws, raw) {
  const r = room.round;
  if (room.phase !== 'guess') return err(ws, '지금은 추측할 수 없어요.');
  if (p.id !== r.liarId) return err(ws, '라이어만 제시어를 추측할 수 있어요.');
  if (r.guessUsed) return err(ws, '추측 기회는 한 번뿐이에요.');
  const text = cleanLine(raw);
  if (!text) return err(ws, '제시어를 입력해 주세요.');
  if (text.length > GUESS_MAX) return err(ws, `${GUESS_MAX}자 이내로 입력해 주세요.`);
  r.guessUsed = true;
  r.guess = text;
  const correct = answers(r).some((a) => normalize(a) === normalize(text));
  finish(room, correct ? 'liar' : 'citizen', correct ? 'guessCorrect' : 'guessWrong');
}

function finish(room, winner, reason) {
  clearPhaseTimer(room);
  const r = room.round;
  const winners = winner === 'liar' ? [r.liarId] : r.participants.filter((id) => id !== r.liarId);
  // 시민 승리면 시민 각자 citizenWin점, 라이어 승리면 라이어 liarWin점. 같은 방에서 누적
  const points = winner === 'liar' ? r.points.liarWin : r.points.citizenWin;
  for (const id of winners) {
    const p = room.players.get(id);
    if (p) p.score += points;
  }
  r.result = {
    winner,
    points,
    reason,
    winners,
    firstTally: r.firstTally || {},
    revoteTally: r.revoteTally,
    candidates: r.candidates,
    votes: Object.fromEntries(r.votes),
    revotes: r.candidates ? Object.fromEntries(r.revotes) : null,
    confirmTally: r.confirmTally,
    confirms: r.confirmTally ? Object.fromEntries(r.confirms) : null,
    guess: r.guess,
  };
  setPhase(room, 'result', null, null);
  system(room, winner === 'liar' ? `라이어(${r.names[r.liarId]}) 승리!` : '시민 승리!');
}

function voidRound(room, why) {
  clearPhaseTimer(room);
  room.round = null;
  room.phase = 'lobby';
  room.deadline = null;
  room.duration = null;
  system(room, `${why} 라운드가 무효 처리되어 점수 없이 대기실로 돌아갑니다.`);
  broadcastState(room);
}

// ---------- 입장 / 퇴장 / 재접속 ----------
function validNickname(raw) {
  const n = cleanLine(raw);
  if (!n) return [null, '닉네임을 입력해 주세요.'];
  if ([...n].length > NICK_MAX) return [null, `닉네임은 ${NICK_MAX}자 이내로 정해 주세요.`];
  return [n, null];
}

function attach(ws, room, p) {
  lobbyWatchers.delete(ws); // 방에 들어가면 로비 목록은 더 받지 않음
  ws.room = room;
  ws.player = p;
  p.ws = ws;
  p.connected = true;
  send(ws, { t: 'joined', code: room.code, token: p.token, playerId: p.id, emojis: EMOJIS });
  send(ws, { t: 'history', msgs: room.chat });
}

function addPlayer(room, ws, nickname, spectator = false) {
  const p = {
    id: crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(18).toString('hex'),
    nickname,
    joinedAt: ++joinSeq,
    connected: true,
    spectator,
    ws: null,
    score: 0,
    graceTimer: null,
    chatTimes: [],
  };
  room.players.set(p.id, p);
  if (!room.hostId && !spectator) room.hostId = p.id;
  attach(ws, room, p);
  system(room, spectator ? `${nickname}님이 관전자로 입장했습니다.` : `${nickname}님이 입장했습니다.`);
  broadcastState(room);
}

// 대기실·결과 화면에서만 참가자 ↔ 관전자를 바꿀 수 있습니다.
function setSpectator(room, p, ws, value, by = null) {
  value = !!value;
  if (ROUND_PHASES.has(room.phase)) return err(ws, '라운드가 끝난 뒤에 바꿀 수 있어요.');
  if (p.spectator === value) return;
  if (by) {
    // 방장이 다른 사람을 관전으로 보냄
    if (spectatorList(room).length >= MAX_SPECTATORS) return err(ws, `관전자 자리가 가득 찼어요. (최대 ${MAX_SPECTATORS}명)`);
    p.spectator = true;
    system(room, `방장 ${by.nickname}님이 ${p.nickname}님을 관전으로 보냈습니다.`);
    ensureHost(room);
    return broadcastState(room);
  }
  if (!value && activePlayers(room).length >= MAX_PLAYERS) return err(ws, `참가자 자리가 가득 찼어요. (최대 ${MAX_PLAYERS}명)`);
  if (value && spectatorList(room).length >= MAX_SPECTATORS) return err(ws, `관전자 자리가 가득 찼어요. (최대 ${MAX_SPECTATORS}명)`);
  p.spectator = value;
  if (!value) p.joinedAt = ++joinSeq; // 방장 승계 순서는 참가자로 들어온 순서 기준
  system(room, value ? `${p.nickname}님이 관전으로 전환했습니다.` : `${p.nickname}님이 게임에 참가합니다.`);
  ensureHost(room);
  broadcastState(room);
}

function createRoom(ws, msg) {
  const [nickname, e] = validNickname(msg.nickname);
  if (e) return err(ws, e);
  const rawName = cleanLine(msg.roomName);
  if ([...rawName].length > ROOM_NAME_MAX) return err(ws, `방 이름은 ${ROOM_NAME_MAX}자 이내로 정해 주세요.`);
  const room = {
    code: makeCode(),
    name: rawName || fishName(), // 비우면 물고기 이름
    createdAt: Date.now(),
    players: new Map(),
    hostId: null,
    phase: 'lobby',
    deadline: null,
    duration: null,
    timer: null,
    roundNo: 0,
    round: null,
    chat: [],
    msgSeq: 0,
    usedWords: new Set(),
    settings: { ...DEFAULT_POINTS },
  };
  rooms.set(room.code, room);
  addPlayer(room, ws, nickname);
}

function joinRoom(ws, msg) {
  const code = cleanLine(msg.code).toUpperCase();
  const room = rooms.get(code);
  if (!room) return err(ws, '그런 방 코드를 찾을 수 없어요.');
  const [nickname, e] = validNickname(msg.nickname);
  if (e) return err(ws, e);
  const spectate = !!msg.spectate;
  if (spectate) {
    // 관전은 라운드 진행 중에도 입장할 수 있습니다.
    if (spectatorList(room).length >= MAX_SPECTATORS) return err(ws, `관전자 자리가 가득 찼어요. (최대 ${MAX_SPECTATORS}명)`);
  } else {
    if (ROUND_PHASES.has(room.phase)) return err(ws, '라운드가 진행 중이라 지금은 참가할 수 없어요. 관전으로 입장하면 지금 바로 볼 수 있어요.', 'can_spectate');
    if (activePlayers(room).length >= MAX_PLAYERS) return err(ws, `참가자 자리가 가득 찼어요. (최대 ${MAX_PLAYERS}명) 관전으로는 입장할 수 있어요.`, 'can_spectate');
  }
  for (const p of room.players.values()) {
    if (p.nickname.toLowerCase() === nickname.toLowerCase()) return err(ws, '이미 같은 닉네임을 쓰는 사람이 있어요.');
  }
  addPlayer(room, ws, nickname, spectate);
}

function resume(ws, msg) {
  const room = rooms.get(cleanLine(msg.code).toUpperCase());
  const p = room && [...room.players.values()].find((x) => x.token === msg.token);
  if (!p) return err(ws, '이전 접속 정보가 만료되었어요. 다시 입장해 주세요.', 'resume_failed');
  if (p.ws && p.ws !== ws) {
    const old = p.ws;
    old.player = null;
    old.room = null;
    send(old, { t: 'replaced' });
    old.close();
  }
  const wasAway = !p.connected;
  if (p.graceTimer) clearTimeout(p.graceTimer);
  p.graceTimer = null;
  attach(ws, room, p);
  if (wasAway) system(room, `${p.nickname}님이 다시 연결되었습니다.`);
  broadcastState(room);
}

function removePlayer(room, id, why) {
  const p = room.players.get(id);
  if (!p) return;
  if (p.graceTimer) clearTimeout(p.graceTimer);
  room.players.delete(id);
  if (p.ws) {
    p.ws.player = null;
    p.ws.room = null;
    p.ws = null;
  }
  if (room.players.size === 0) {
    clearPhaseTimer(room);
    rooms.delete(room.code);
    scheduleLobby();
    return;
  }
  const who = p.spectator ? `관전자 ${p.nickname}` : p.nickname;
  system(room, why === 'timeout'
    ? `${who}님이 재접속 시간(60초)이 지나 퇴장 처리되었습니다.`
    : why === 'kick' ? `방장이 ${who}님을 내보냈습니다.`
    : `${who}님이 퇴장했습니다.`);
  // 방장이 나가면 남은 참가자 중 입장이 가장 빠른 사람에게 넘깁니다.
  ensureHost(room);
  if (room.round && ROUND_PHASES.has(room.phase) && room.round.participants.includes(id)) {
    voidRound(room, `${p.nickname}님이 라운드를 떠나`);
  } else {
    broadcastState(room);
  }
}

function onDisconnect(ws) {
  const p = ws.player;
  const room = ws.room;
  if (!p || !room || p.ws !== ws) return;
  p.ws = null;
  p.connected = false;
  // 타이머는 계속 흐르고, 유예 시간이 끝난 뒤에만 퇴장(방장 위임 포함)을 처리합니다.
  p.graceTimer = setTimeout(() => removePlayer(room, p.id, 'timeout'), TIMES.grace);
  system(room, `${p.nickname}님의 연결이 끊겼습니다. 60초 안에 돌아오지 않으면 퇴장 처리됩니다.`);
  broadcastState(room);
}

function onChat(room, p, ws, raw) {
  if (!CHAT_PHASES.has(room.phase)) return err(ws, '지금 단계에서는 채팅할 수 없어요.');
  // 토론은 라운드 참가자끼리만. 관전자는 대기실·결과 화면에서 채팅합니다.
  if (p.spectator && room.phase === 'discussion') return err(ws, '토론 중에는 참가자만 채팅할 수 있어요. 관전자는 결과 화면에서 채팅할 수 있어요.');
  const defense = room.phase === 'defense';
  if (defense && p.id !== room.round.accusedId) return err(ws, '최후의 변론 중에는 지목된 사람만 말할 수 있어요.');
  const text = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return;
  if ([...text].length > CHAT_MAX) return err(ws, `메시지는 최대 ${CHAT_MAX}자까지 보낼 수 있어요.`);
  const now = Date.now();
  p.chatTimes = p.chatTimes.filter((t) => now - t < 5000);
  if (p.chatTimes.length >= 6) return err(ws, '메시지를 너무 빨리 보내고 있어요. 잠시 후 다시 시도해 주세요.');
  p.chatTimes.push(now);
  addChat(room, {
    kind: 'user', playerId: p.id, nickname: p.nickname, spectator: !!p.spectator, text,
    ...(defense ? { defense: true, round: room.round.no } : {}),
  });
}

// ---------- 방장 권한 ----------
function hostTarget(room, p, ws, targetId) {
  if (room.hostId !== p.id) { err(ws, '방장만 할 수 있어요.'); return null; }
  const t = room.players.get(String(targetId));
  if (!t) { err(ws, '그 사람은 이미 방에 없어요.'); return null; }
  if (t.id === p.id) { err(ws, '자기 자신에게는 할 수 없어요.'); return null; }
  return t;
}

function setPoints(room, p, ws, msg) {
  if (room.hostId !== p.id) return err(ws, '방장만 점수를 바꿀 수 있어요.');
  if (ROUND_PHASES.has(room.phase)) return err(ws, '점수는 라운드가 끝난 뒤에 바꿀 수 있어요.');
  const next = { ...room.settings };
  for (const k of ['citizenWin', 'liarWin']) {
    if (msg[k] === undefined) continue;
    const v = Number(msg[k]);
    if (!Number.isInteger(v) || v < 0 || v > POINTS_MAX) return err(ws, `점수는 0~${POINTS_MAX} 사이 정수로 정해 주세요.`);
    next[k] = v;
  }
  if (next.citizenWin === room.settings.citizenWin && next.liarWin === room.settings.liarWin) return;
  room.settings = next;
  system(room, `점수 규칙 변경: 시민 승리 ${next.citizenWin}점 · 라이어 승리 ${next.liarWin}점`);
  broadcastState(room);
}

function kick(room, p, ws, targetId) {
  const t = hostTarget(room, p, ws, targetId);
  if (!t) return;
  send(t.ws, { t: 'kicked' });
  // 진행 중인 라운드의 참가자라면 나가기와 똑같이 라운드가 무효 처리됩니다.
  removePlayer(room, t.id, 'kick');
}

function forceSpectate(room, p, ws, targetId) {
  const t = hostTarget(room, p, ws, targetId);
  if (!t) return;
  if (t.spectator) return err(ws, '이미 관전 중이에요.');
  setSpectator(room, t, ws, true, p);
}

function transferHost(room, p, ws, targetId) {
  const t = hostTarget(room, p, ws, targetId);
  if (!t) return;
  if (t.spectator) return err(ws, '관전자에게는 방장을 넘길 수 없어요.');
  room.hostId = t.id;
  system(room, `${p.nickname}님이 ${t.nickname}님에게 방장을 넘겼습니다.`);
  broadcastState(room);
}

// 어느 단계에서든, 관전자도 보낼 수 있습니다. 기록은 남기지 않고 바로 중계만 합니다.
function onReact(room, p, emoji) {
  if (!EMOJI_SET.has(emoji)) return;
  const now = Date.now();
  const b = p.reactBucket || (p.reactBucket = { tokens: REACT_BURST, at: now });
  b.tokens = Math.min(REACT_BURST, b.tokens + ((now - b.at) / 1000) * REACT_PER_SEC);
  b.at = now;
  if (b.tokens < 1) return; // 너무 빠른 연타는 조용히 버림
  b.tokens -= 1;
  const msg = { t: 'react', emoji, playerId: p.id };
  for (const q of room.players.values()) sendTo(q, msg);
}

// ---------- 메시지 라우팅 ----------
function onMessage(ws, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (!msg || typeof msg.t !== 'string') return;

  if (!ws.player) {
    if (msg.t === 'lobby') { lobbyWatchers.add(ws); return sendRoomList(ws); }
    if (msg.t === 'create') return createRoom(ws, msg);
    if (msg.t === 'join') return joinRoom(ws, msg);
    if (msg.t === 'resume') return resume(ws, msg);
    return err(ws, '먼저 방에 입장해 주세요.');
  }
  const p = ws.player;
  const room = ws.room;
  switch (msg.t) {
    case 'start': return startRound(room, p, ws);
    case 'chat': return onChat(room, p, ws, msg.text);
    case 'hint': return submitHint(room, p, ws, msg.text);
    case 'vote': return castVote(room, p, ws, String(msg.targetId));
    case 'guess': return submitGuess(room, p, ws, msg.text);
    case 'confirm': return castConfirm(room, p, ws, msg.agree === true);
    case 'react': return onReact(room, p, String(msg.emoji));
    case 'time': return adjustDiscussion(room, p, ws, msg.dir);
    case 'spectate': return setSpectator(room, p, ws, msg.value);
    case 'points': return setPoints(room, p, ws, msg);
    case 'kick': return kick(room, p, ws, msg.targetId);
    case 'forceSpectate': return forceSpectate(room, p, ws, msg.targetId);
    case 'transferHost': return transferHost(room, p, ws, msg.targetId);
    case 'leave':
      send(ws, { t: 'left' });
      return removePlayer(room, p.id, 'leave');
    default: return err(ws, '알 수 없는 요청이에요.');
  }
}

// ---------- HTTP + WebSocket ----------
const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(INDEX, (e, buf) => {
      if (e) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  // 다른 사이트에 심은 스크립트가 내 게임 서버에 붙지 못하게 Origin을 확인합니다.
  verifyClient: ({ origin }) => ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin),
});
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    try { onMessage(ws, data.toString()); } catch (e) { console.error(e); err(ws, '서버 오류가 발생했어요.'); }
  });
  ws.on('close', () => { lobbyWatchers.delete(ws); onDisconnect(ws); });
  ws.on('error', () => {});
});
// 응답 없는 연결을 정리해 끊김을 빨리 감지합니다.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000).unref();

server.listen(PORT, HOST, () => {
  console.log(`라이어 게임 서버: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`
    + (SCALE !== 1 ? ` (시간 배율 ${SCALE})` : '')
    + (ALLOWED_ORIGINS.length ? ` · 허용 Origin: ${ALLOWED_ORIGINS.join(', ')}` : ''));
});

// systemctl stop/restart 때 접속자에게 정상 종료를 알리고 내려갑니다.
// (방 상태는 메모리에만 있으므로 재시작하면 사라집니다.)
function shutdown() {
  for (const ws of wss.clients) ws.close(1001, 'server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
