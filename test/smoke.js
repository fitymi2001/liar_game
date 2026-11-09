'use strict';
// 실제 서버를 시간 배율 0.1로 띄우고 여러 클라이언트로 규칙을 검증합니다.
// 실행: node test/smoke.js
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const assert = require('assert/strict');

const PORT = 3999;
const URL = `ws://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) { this.name = name; this.state = null; this.errors = []; this.chat = []; this.waiters = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'state') this.state = m;
        if (m.t === 'rooms') this.rooms = m.rooms;
        if (m.t === 'error') this.errors.push(m);
        if (m.t === 'chat') this.chat.push(m.msg);
        if (m.t === 'history') this.chat = m.msgs.slice();
        if (m.t === 'joined') { this.code = m.code; this.token = m.token; this.id = m.playerId; }
        for (const w of this.waiters.slice()) if (w.pred(this)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(); }
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  until(pred, ms = 8000, label = '') {
    if (pred(this)) return Promise.resolve();
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => rej(new Error(`[${this.name}] timeout: ${label}`)), ms);
    });
  }
  phase(p, ms) { return this.until((c) => c.state && c.state.phase === p, ms, `phase ${p}`); }
  async expectError(fn, re) {
    const n = this.errors.length;
    fn();
    await this.until((c) => c.errors.length > n, 3000, `error ${re}`);
    assert.match(this.errors[this.errors.length - 1].message, re);
  }
  close() { this.ws.close(); }
}

let ok = 0;
const check = (label) => { ok++; console.log('  ✓', label); };

async function joinAll(names) {
  const cs = names.map((n) => new Client(n));
  for (const c of cs) await c.open();
  cs[0].send({ t: 'create', nickname: names[0] });
  await cs[0].until((c) => c.code, 3000, 'create');
  for (const c of cs.slice(1)) {
    c.send({ t: 'join', code: cs[0].code, nickname: c.name });
    await c.until((x) => x.code, 3000, 'join');
  }
  await cs[0].until((c) => c.state.players.length === names.length);
  return cs;
}
const byId = (cs, id) => cs.find((c) => c.id === id);
const ROUND_IN = ['role', 'hint', 'discussion', 'vote', 'revote', 'defense', 'confirm', 'guess'];

async function playHints(cs, makeText) {
  // 힌트 차례를 따라 각자 제출
  const host = cs[0];
  for (let i = 0; i < host.state.round.order.length; i++) {
    await host.until((c) => c.state.phase === 'hint' && c.state.round.turn === i, 5000, `turn ${i}`);
    const who = byId(cs, host.state.round.order[i]);
    who.send({ t: 'hint', text: makeText(who, i) });
  }
}

// 최후의 변론이 끝나고 찬반 투표가 열리면 지목된 사람을 뺀 참가자 전원이 투표
async function confirmAll(cs, agree, observer = cs[0]) {
  await observer.phase('confirm', 5000);
  const acc = observer.state.round.accusedId;
  for (const c of cs) if (c.id !== acc) c.send({ t: 'confirm', agree });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), LIAR_TIME_SCALE: '0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => server.stdout.once('data', r));
  try {
    console.log('입장/대기실');
    const cs = await joinAll(['민수', '지영', '현우']);
    const [A, B, C] = cs;
    assert.equal(A.code.length, 6); check('6자리 방 코드 생성');
    assert.equal(A.state.hostId, A.id); check('방 만든 사람이 방장');

    const X = new Client('X'); await X.open();
    await X.expectError(() => X.send({ t: 'join', code: 'ZZZZZZ', nickname: 'x' }), /찾을 수 없/); check('없는 방 코드 거부');
    await X.expectError(() => X.send({ t: 'join', code: A.code, nickname: '민수' }), /같은 닉네임/); check('중복 닉네임 거부');
    await B.expectError(() => B.send({ t: 'start' }), /방장만/); check('방장 아닌 사람은 시작 불가');

    B.send({ t: 'chat', text: '안녕하세요' });
    await A.until((c) => c.chat.some((m) => m.text === '안녕하세요' && m.nickname === '지영'));
    check('대기실 채팅 전달 (닉네임 포함)');
    await B.expectError(() => B.send({ t: 'chat', text: 'ㄱ'.repeat(201) }), /200자/); check('201자 채팅 거부');

    // 이모지 반응
    let reacts = [];
    C.ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'react') reacts.push(m); });
    B.send({ t: 'react', emoji: '😂' });
    B.send({ t: 'react', emoji: '<script>' });
    await sleep(300);
    assert.equal(reacts.length, 1);
    assert.equal(reacts[0].emoji, '😂'); assert.equal(reacts[0].playerId, B.id);
    check('이모지 반응 중계, 목록 밖 값은 무시');
    reacts = [];
    for (let i = 0; i < 60; i++) B.send({ t: 'react', emoji: '🔥' });
    await sleep(400);
    assert.ok(reacts.length >= 15 && reacts.length <= 26, `burst ${reacts.length}`);
    check(`연타는 허용하되 상한 적용 (60번 → ${reacts.length}개 중계)`);

    console.log('라운드 1: 라이어 지목 → 추측 실패 → 시민 승리');
    A.send({ t: 'start' });
    await Promise.all(cs.map((c) => c.phase('role')));
    const r1 = A.state.round;
    const liarId = cs.find((c) => c.state.round.role === 'liar').id;
    assert.equal(cs.filter((c) => c.state.round.role === 'liar').length, 1); check('라이어는 정확히 한 명');
    const word = cs.find((c) => c.state.round.role === 'citizen').state.round.word;
    for (const c of cs) {
      if (c.id === liarId) assert.equal(c.state.round.word, null);
      else assert.equal(c.state.round.word, word);
    }
    check('제시어는 시민에게만 전송');
    await A.expectError(() => A.send({ t: 'chat', text: 'x' }), /채팅할 수 없/); check('역할 확인 중 채팅 잠김');
    await X.expectError(() => X.send({ t: 'join', code: A.code, nickname: '늦은사람' }), /진행 중/); check('진행 중 새 참가자 입장 거부');

    await A.phase('hint', 4000);
    const first = byId(cs, A.state.round.order[0]);
    const notFirst = cs.find((c) => c !== first);
    await notFirst.expectError(() => notFirst.send({ t: 'hint', text: '내 힌트' }), /차례가 아니/); check('차례가 아닌 힌트 거부');
    if (first.id !== liarId) {
      await first.expectError(() => first.send({ t: 'hint', text: `이건 ${word} 맞아요` }), /제시어/);
      check('시민 힌트에 제시어 포함 시 거부');
    }
    await playHints(cs, (c, i) => `${c.name}의 힌트 ${i + 1}`);
    await A.phase('discussion');
    assert.equal(A.state.round.hints.length, 3);
    assert.deepEqual(A.state.round.hints.map((h) => h.order), [1, 2, 3]);
    check('힌트가 발표 순서·작성자와 함께 기록됨');
    A.send({ t: 'chat', text: '토론 시작' });
    await B.until((c) => c.chat.some((m) => m.text === '토론 시작')); check('토론 중 채팅 가능');

    // 토론 시간 줄이기/늘리기: 한 사람당 둘 중 하나만 한 번, (토론 시간 ÷ 참가자 수)씩
    const d0 = A.state.deadline;
    A.send({ t: 'time', dir: 'cut' });
    await B.until((c) => Object.keys(c.state.round.timeVotes).length === 1, 3000, 'cut 1');
    assert.ok(Math.abs((d0 - B.state.deadline) - 2000) < 50, `cut ${d0 - B.state.deadline}`);
    check('줄이기 → 마감이 (토론 시간 ÷ 참가자 수)만큼 당겨짐');
    await A.expectError(() => A.send({ t: 'time', dir: 'add' }), /하나만/); check('줄인 사람은 늘리기 불가 (둘 중 하나만)');
    await A.expectError(() => A.send({ t: 'time', dir: 'cut' }), /한 번만/); check('줄이기는 한 사람당 한 번');
    B.send({ t: 'time', dir: 'add' });
    await A.until((c) => Object.keys(c.state.round.timeVotes).length === 2, 3000, 'add 1');
    assert.ok(Math.abs(A.state.deadline - d0) < 50, `net ${A.state.deadline - d0}`);
    assert.equal(A.state.round.timeVotes[B.id], 'add');
    check('늘리기 → 같은 시간만큼 마감이 늦춰짐');
    C.send({ t: 'time', dir: 'cut' });
    await A.until((c) => Object.keys(c.state.round.timeVotes).length === 3, 3000, 'cut 2');
    assert.equal(A.state.phase, 'discussion'); check('한 명이라도 늘렸으면 모두 눌러도 토론 계속');

    await A.phase('vote', 9000);
    await A.expectError(() => A.send({ t: 'time', dir: 'cut' }), /토론 중에만/); check('토론이 아닐 때는 줄이기·늘리기 불가');
    const liar = byId(cs, liarId);
    await liar.expectError(() => liar.send({ t: 'vote', targetId: liarId }), /자기 자신/); check('자기 자신 투표 거부');
    const others = cs.filter((c) => c.id !== liarId);
    for (const c of others) c.send({ t: 'vote', targetId: liarId });
    liar.send({ t: 'vote', targetId: others[0].id });
    await others[0].expectError(() => others[0].send({ t: 'vote', targetId: liarId }), /(이미 투표|투표 시간)/);
    check('투표 변경 불가');
    await A.phase('defense', 3000);
    assert.equal(A.state.round.accusedId, liarId); check('전원 투표 시 즉시 집계 → 최다 득표자 최후의 변론');
    await others[0].expectError(() => others[0].send({ t: 'chat', text: '아니야' }), /지목된 사람만/); check('변론 중 다른 사람 채팅 차단');
    liar.send({ t: 'chat', text: '저 진짜 시민이에요' });
    await A.until((c) => c.chat.some((m) => m.defense && m.text === '저 진짜 시민이에요')); check('지목된 사람의 변론 메시지 (변론 표시)');
    await A.phase('confirm', 3000);
    await liar.expectError(() => liar.send({ t: 'confirm', agree: false }), /지목된 사람은/); check('지목된 사람은 찬반 투표 불가');
    for (const c of others) c.send({ t: 'confirm', agree: true });
    await A.phase('guess', 3000); check('찬성 과반 → 지목 확정 → 라이어 추측');
    await others[0].expectError(() => others[0].send({ t: 'guess', text: word }), /라이어만/); check('라이어만 추측 가능');
    liar.send({ t: 'guess', text: '절대아닌단어' });
    await A.phase('result');
    assert.equal(A.state.round.result.winner, 'citizen');
    assert.equal(A.state.round.result.reason, 'guessWrong');
    assert.equal(A.state.round.word, word);
    for (const c of cs) assert.equal(A.state.players.find((p) => p.id === c.id).score, c.id === liarId ? 0 : 1);
    check('오답 → 시민 승리, 시민만 1점');

    console.log('라운드 2: 시간 초과 힌트 + 동률 → 재투표 동률 → 라이어 승리');
    A.send({ t: 'start' });
    await A.phase('discussion', 15000); // 아무도 힌트를 내지 않으면 차례가 계속 넘어감
    assert.ok(A.state.round.hints.every((h) => h.text === null)); check('시간 초과 시 힌트 차례 넘어감');
    const tAll = Date.now();
    for (const c of cs) c.send({ t: 'time', dir: 'cut' });
    await A.phase('vote', 3000);
    assert.ok(Date.now() - tAll < 1000); check('모두 줄이기를 누르면 바로 투표로');
    // A→B, B→C, C→A : 1:1:1 동률
    A.send({ t: 'vote', targetId: B.id }); B.send({ t: 'vote', targetId: C.id }); C.send({ t: 'vote', targetId: A.id });
    await A.phase('revote', 3000);
    assert.equal(A.state.round.candidates.length, 3); check('동률 후보만 재투표');
    A.send({ t: 'vote', targetId: B.id }); B.send({ t: 'vote', targetId: C.id }); C.send({ t: 'vote', targetId: A.id });
    await A.phase('result', 3000);
    assert.equal(A.state.round.result.winner, 'liar'); assert.equal(A.state.round.result.reason, 'revoteTie');
    check('재투표도 동률 → 라이어 승리');

    console.log('라운드 3: 전원 기권 → 라이어 승리');
    A.send({ t: 'start' });
    await A.phase('vote', 20000);
    await A.phase('result', 4000);
    assert.equal(A.state.round.result.reason, 'allAbstain'); check('전원 기권 → 라이어 승리');

    console.log('라운드 4: 시민 지목 → 라이어 승리');
    A.send({ t: 'start' });
    await A.phase('vote', 20000);
    const l4 = A.state.round.order.find((id) => byId(cs, id).state.round.role === 'liar');
    const victim = cs.find((c) => c.id !== l4);
    for (const c of cs) c.send({ t: 'vote', targetId: c === victim ? cs.find((x) => x !== victim).id : victim.id });
    await confirmAll(cs, true);
    await A.phase('result', 3000);
    assert.equal(A.state.round.result.reason, 'citizenAccused'); check('시민 지목 확정 → 라이어 승리');
    assert.deepEqual(A.state.round.result.confirmTally, { yes: 2, no: 0 }); check('결과에 찬반 집계 공개');

    console.log('라운드 5: 라이어 지목 → 정답 추측 → 라이어 승리');
    A.send({ t: 'start' });
    await A.phase('vote', 20000);
    const l5 = byId(cs, A.state.round.order.find((id) => byId(cs, id).state.round.role === 'liar'));
    const w5 = cs.find((c) => c !== l5).state.round.word;
    for (const c of cs) c.send({ t: 'vote', targetId: c === l5 ? cs.find((x) => x !== l5).id : l5.id });
    await confirmAll(cs, true);
    await l5.phase('guess', 3000);
    const before = A.state.players.find((p) => p.id === l5.id).score;
    l5.send({ t: 'guess', text: ` ${[...w5].join(' ')}! ` });
    await A.phase('result', 3000);
    assert.equal(A.state.round.result.reason, 'guessCorrect');
    assert.equal(A.state.players.find((p) => p.id === l5.id).score, before + 3);
    check('공백·문장부호를 무시하고 정답 판정 → 라이어 승리 +3 (기본 점수)');

    console.log('라운드 6: 최후의 변론 후 찬반 부결 → 라이어 승리');
    A.send({ t: 'start' });
    await A.phase('vote', 20000);
    const l6 = byId(cs, A.state.round.order.find((id) => byId(cs, id).state.round.role === 'liar'));
    const s6 = A.state.players.find((p) => p.id === l6.id).score;
    for (const c of cs) c.send({ t: 'vote', targetId: c === l6 ? cs.find((x) => x !== l6).id : l6.id });
    await confirmAll(cs, false); // 라이어를 지목해 놓고도 부결
    await A.phase('result', 3000);
    assert.equal(A.state.round.result.reason, 'acquitted');
    assert.equal(A.state.round.result.winner, 'liar');
    assert.equal(A.state.players.find((p) => p.id === l6.id).score, s6 + 3);
    check('찬반 부결 → 라이어 승리 +3');
    A.send({ t: 'start' });
    await A.phase('vote', 20000);
    const t7 = cs[1];
    for (const c of cs) c.send({ t: 'vote', targetId: c === t7 ? cs[0].id : t7.id });
    await A.phase('confirm', 5000);
    await A.phase('result', 3000); // 아무도 찬반 투표 안 함
    assert.equal(A.state.round.result.reason, 'acquitted'); check('찬반 전원 기권 → 부결');

    console.log('재접속');
    A.send({ t: 'start' });
    await A.phase('hint', 4000);
    const cId = C.id, cToken = C.token;
    C.close();
    await A.until((c) => c.state.players.find((p) => p.id === cId && !p.connected)); check('연결 끊김 표시');
    const C2 = new Client('현우2'); await C2.open();
    C2.send({ t: 'resume', code: A.code, token: cToken });
    await C2.until((c) => c.state && c.state.me === cId, 3000, 'resume');
    assert.notEqual(C2.state.phase, 'lobby'); check('60초(배율) 안에 복귀하면 같은 참가자로 라운드 계속');
    C2.close();
    await A.phase('lobby', 9000);
    assert.ok(!A.state.players.some((p) => p.id === cId));
    assert.ok(A.chat.some((m) => /무효/.test(m.text)));
    check('유예 시간 경과 → 퇴장 + 라운드 무효, 대기실 복귀');
    const scores = Object.fromEntries(A.state.players.map((p) => [p.id, p.score]));

    console.log('방장 위임 / 정원');
    const D = new Client('D'); await D.open(); D.send({ t: 'join', code: A.code, nickname: '다은' }); await D.until((c) => c.code);
    A.send({ t: 'leave' });
    await B.until((c) => c.state.hostId === B.id); check('방장이 나가면 가장 먼저 들어온 사람에게 위임');
    assert.equal(B.state.players.find((p) => p.id === B.id).score, scores[B.id]); check('무효 라운드는 점수 변화 없음');
    const extra = [];
    for (const n of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']) {
      const c = new Client(n); await c.open(); extra.push(c);
      c.send({ t: 'join', code: A.code, nickname: n });
      await c.until((x) => x.code || x.errors.length > 0, 3000, 'join extra');
    }
    assert.equal(B.state.players.length, 10);
    assert.match(extra[8].errors[0].message, /가득/); check('11번째 입장 거부 (최대 10명)');
    const ten = [B, D, ...extra.slice(0, 8)];
    B.send({ t: 'start' });
    await Promise.all(ten.map((c) => c.phase('role', 3000)));
    assert.equal(B.state.round.order.length, 10);
    assert.equal(ten.filter((c) => c.state.round.role === 'liar').length, 1);
    assert.equal(ten.filter((c) => c.state.round.word === null).length, 1);
    check('10명 라운드 시작 — 라이어 1명, 발표 순서 10명');
    // 관전자는 참가자 10명과 별도로 20명까지
    const watchers = [];
    for (let i = 0; i < 21; i++) {
      const c = new Client(`관${i}`); await c.open(); watchers.push(c);
      c.send({ t: 'join', code: B.code, nickname: `관${i}`, spectate: true });
      await c.until((x) => x.code || x.errors.length > 0, 3000, 'spectator join');
    }
    await B.until((c) => c.state.spectators.length === 20, 3000, '20 spectators');
    assert.equal(B.state.players.length, 10);
    assert.match(watchers[20].errors[0].message, /관전자 자리가 가득/);
    check('참가자 10명이 꽉 차도 관전자 20명 입장, 21번째 거부');
    for (const c of watchers) c.close();

    for (const c of [B, D, X, ...extra]) c.close();

    console.log('관전자');
    const ps = await joinAll(['가', '나', '다']);
    const [P1, P2, P3] = ps;
    const S = new Client('관전1'); await S.open();
    S.send({ t: 'join', code: P1.code, nickname: '관전1', spectate: true });
    await S.until((c) => c.state, 3000, 'spectator join');
    assert.equal(S.state.meSpectator, true);
    await P1.until((c) => c.state.spectators.length === 1);
    assert.equal(P1.state.players.length, 3);
    check('관전자로 입장 — 참가자 목록과 분리');
    await S.expectError(() => S.send({ t: 'start' }), /방장만/); check('관전자는 방장이 될 수 없음');

    P1.send({ t: 'start' });
    await S.phase('role');
    assert.equal(S.state.round.role, 'spectator');
    assert.equal(S.state.round.word, null);
    assert.equal(S.state.round.liarId, undefined);
    assert.ok(!S.state.round.order.includes(S.id));
    check('관전자에게는 결과 전까지 제시어·라이어 비공개, 발표 순서에서 제외');

    const L = new Client('늦관전'); await L.open();
    L.send({ t: 'join', code: P1.code, nickname: '늦관전', spectate: true });
    await L.until((c) => c.state, 3000, 'late spectator');
    assert.equal(L.state.round.word, null); check('라운드 진행 중에도 관전 입장 가능');
    const late = new Client('늦참가'); await late.open();
    await late.expectError(() => late.send({ t: 'join', code: P1.code, nickname: '늦참가' }), /관전으로 입장/);
    check('진행 중 참가 거부 시 관전 안내');
    await S.expectError(() => S.send({ t: 'spectate', value: false }), /라운드가 끝난 뒤/); check('라운드 중 참가 전환 불가');

    await playHints(ps, (c, i) => `${c.name} 힌트 ${i}`);
    await S.phase('discussion');
    await S.expectError(() => S.send({ t: 'chat', text: '저 사람 같아요' }), /참가자만/); check('토론 중 관전자 채팅 차단');
    await S.expectError(() => S.send({ t: 'time', dir: 'add' }), /참가자만/); check('관전자는 토론 시간 줄이기·늘리기 불가');
    await S.phase('vote', 9000);
    await S.expectError(() => S.send({ t: 'vote', targetId: P1.id }), /참가자만/); check('관전자 투표 불가');
    L.close(); // 관전자의 연결 끊김은 라운드에 영향 없음
    for (const c of ps) c.send({ t: 'vote', targetId: ps.find((x) => x !== c).id });
    await S.until((c) => ['defense', 'revote'].includes(c.state.phase), 3000, 'after vote');
    if (S.state.phase === 'revote') {
      for (const c of ps) c.send({ t: 'vote', targetId: S.state.round.candidates.find((id) => id !== c.id) });
      await S.until((c) => ['defense', 'result'].includes(c.state.phase), 3000, 'after revote');
    }
    if (S.state.phase === 'defense') {
      await S.phase('confirm', 3000);
      await S.expectError(() => S.send({ t: 'confirm', agree: true }), /참가자만/); check('관전자 찬반 투표 불가');
      await confirmAll(ps, true, S);
    }
    await S.until((c) => c.state.phase === 'result' || c.state.phase === 'guess', 3000, 'after confirm');
    if (S.state.phase === 'guess') {
      const lp = ps.find((c) => c.state.round.role === 'liar');
      lp.send({ t: 'guess', text: '모름' });
      await S.phase('result');
    }
    assert.ok(S.state.round.word && S.state.round.liarId); check('결과에서 관전자에게도 제시어·라이어 공개');
    S.send({ t: 'chat', text: '재밌다' });
    await P1.until((c) => c.chat.some((m) => m.text === '재밌다' && m.spectator)); check('결과 화면에서 관전자 채팅 (관전 표시)');

    S.send({ t: 'spectate', value: false });
    await P1.until((c) => c.state.players.length === 4 && c.state.players.some((p) => p.id === S.id)); check('결과 화면에서 관전 → 참가 전환');
    P1.send({ t: 'start' });
    await P1.phase('role');
    assert.ok(P1.state.round.order.includes(S.id)); check('전환한 사람은 다음 라운드에 참여');
    await P1.until((c) => c.chat.some((m) => /관전자 늦관전님이 재접속 시간/.test(m.text)), 9000, 'spectator grace');
    assert.notEqual(P1.state.phase, 'lobby'); check('관전자 유예 만료는 라운드를 무효로 만들지 않음');
    await P1.phase('result', 30000);
    P1.send({ t: 'spectate', value: true });
    await P2.until((c) => c.state.hostId === P2.id); check('방장이 관전으로 전환하면 다음 참가자에게 방장 위임');
    for (const c of [...ps, S, late]) c.close();

    console.log('점수 규칙');
    const qs = await joinAll(['방장', '둘', '셋', '넷']);
    const [H, Q2, Q3, Q4] = qs;
    const W = new Client('구경'); await W.open();
    W.send({ t: 'join', code: H.code, nickname: '구경', spectate: true });
    await W.until((c) => c.state, 3000, 'spectator');
    assert.deepEqual(H.state.settings, { citizenWin: 1, liarWin: 3 }); check('기본 점수: 시민 1점 · 라이어 3점');
    await Q2.expectError(() => Q2.send({ t: 'points', citizenWin: 5 }), /방장만/); check('방장 아닌 사람은 점수 변경 불가');
    await H.expectError(() => H.send({ t: 'points', liarWin: 11 }), /0~10/); check('범위 밖 점수 거부');
    H.send({ t: 'points', citizenWin: 2, liarWin: 5 });
    await Q2.until((c) => c.state.settings.citizenWin === 2 && c.state.settings.liarWin === 5); check('방장이 점수 변경 → 모두에게 반영');
    H.send({ t: 'start' });
    await H.phase('role');
    await H.expectError(() => H.send({ t: 'points', citizenWin: 9 }), /라운드가 끝난 뒤/); check('라운드 중 점수 변경 불가');
    await H.phase('vote', 30000);
    const lq = byId(qs, H.state.round.order.find((id) => byId(qs, id).state.round.role === 'liar'));
    for (const c of qs) c.send({ t: 'vote', targetId: c === lq ? qs.find((x) => x !== lq).id : lq.id });
    await confirmAll(qs, true);
    await lq.phase('guess', 3000);
    lq.send({ t: 'guess', text: '틀린답' });
    await H.phase('result', 3000);
    assert.equal(H.state.round.result.points, 2);
    for (const c of qs) assert.equal(H.state.players.find((p) => p.id === c.id).score, c === lq ? 0 : 2);
    check('시민 승리 → 시민 각자 설정한 2점');

    console.log('방장 권한');
    await Q2.expectError(() => Q2.send({ t: 'kick', targetId: Q3.id }), /방장만/); check('방장 아닌 사람은 추방 불가');
    H.send({ t: 'forceSpectate', targetId: Q4.id });
    await Q4.until((c) => c.state.meSpectator === true); check('방장이 참가자를 관전으로 보냄');
    await H.expectError(() => H.send({ t: 'transferHost', targetId: W.id }), /관전자에게는/); check('관전자에게는 방장 넘기기 불가');
    H.send({ t: 'transferHost', targetId: Q2.id });
    await H.until((c) => c.state.hostId === Q2.id); check('방장 넘기기');
    await H.expectError(() => H.send({ t: 'kick', targetId: Q3.id }), /방장만/); check('넘긴 뒤에는 이전 방장 권한 없음');
    Q2.send({ t: 'start' });
    await Q2.phase('role');
    await Q2.expectError(() => Q2.send({ t: 'forceSpectate', targetId: H.id }), /라운드가 끝난 뒤/); check('라운드 중 관전으로 보내기 불가');
    let kickedMsg = false;
    Q3.ws.on('message', (d) => { if (JSON.parse(d).t === 'kicked') kickedMsg = true; });
    Q2.send({ t: 'kick', targetId: Q3.id });
    await Q2.phase('lobby', 3000);
    assert.ok(kickedMsg); assert.ok(!Q2.state.players.some((p) => p.id === Q3.id));
    assert.ok(Q2.chat.some((m) => /내보냈습니다/.test(m.text)));
    check('라운드 중 참가자 추방 → 본인에게 알림 + 라운드 무효');
    Q2.send({ t: 'kick', targetId: W.id });
    await Q2.until((c) => c.state.spectators.every((s) => s.id !== W.id)); check('관전자 추방');
    for (const c of [...qs, W]) c.close();

    console.log('여러 방 동시 진행');
    const [ra, rb] = await Promise.all([joinAll(['일가', '일나', '일다']), joinAll(['이가', '이나', '이다'])]);
    assert.notEqual(ra[0].code, rb[0].code); check('방마다 다른 코드');
    // 한쪽 방의 채팅·반응이 다른 방으로 새지 않음
    const leak = [];
    for (const c of rb) c.ws.on('message', (d) => { const m = JSON.parse(d); if ((m.t === 'chat' && m.msg.text === '일번방 비밀') || m.t === 'react') leak.push(m); });
    ra[0].send({ t: 'chat', text: '일번방 비밀' });
    ra[1].send({ t: 'react', emoji: '😂' });
    await ra[2].until((c) => c.chat.some((m) => m.text === '일번방 비밀'));
    await sleep(300);
    assert.equal(leak.length, 0); check('채팅·이모지는 같은 방에만 전달');
    // 두 방을 동시에 시작해 각자 진행
    ra[0].send({ t: 'points', liarWin: 7 });
    ra[0].send({ t: 'start' }); rb[0].send({ t: 'start' });
    await Promise.all([...ra, ...rb].map((c) => c.phase('role')));
    assert.equal(rb[0].state.settings.liarWin, 3); check('점수 설정은 방마다 따로');
    for (const room of [ra, rb]) {
      assert.equal(room.filter((c) => c.state.round.role === 'liar').length, 1);
      assert.deepEqual([...room[0].state.round.order].sort(), room.map((c) => c.id).sort());
    }
    check('방마다 자기 참가자만으로 라이어·발표 순서 결정');
    // 1번 방만 힌트를 내고, 2번 방은 내버려 둠
    await playHints(ra, (c, i) => `일번 ${i}`);
    await ra[0].phase('discussion');
    assert.equal(rb[0].state.round.hints.filter((x) => x.text).length, 0); check('한 방의 진행이 다른 방에 영향 없음');
    // 1번 방에서 추방 → 1번 방만 무효
    ra[0].send({ t: 'kick', targetId: ra[2].id });
    await ra[0].phase('lobby', 3000);
    await sleep(200);
    assert.ok(ROUND_IN.includes(rb[0].state.phase), rb[0].state.phase); check('한 방의 라운드 무효가 다른 방엔 영향 없음');
    // 방 30개를 한꺼번에 만들어도 코드가 겹치지 않음
    const many = await Promise.all(Array.from({ length: 30 }, async (_, i) => {
      const c = new Client(`m${i}`); await c.open(); c.send({ t: 'create', nickname: `m${i}` });
      await c.until((x) => x.code, 3000, 'create many'); return c;
    }));
    assert.equal(new Set(many.map((c) => c.code)).size, 30); check('방 30개 동시 생성 — 코드 중복 없음');
    for (const c of [...ra, ...rb, ...many]) c.close();

    console.log('로비 · 방 이름');
    await sleep(400); // 앞에서 닫은 방들이 정리될 시간
    const L1 = new Client('로비'); await L1.open();
    L1.send({ t: 'lobby' });
    await L1.until((c) => Array.isArray(c.rooms), 3000, 'room list');
    const baseCount = L1.rooms.length;
    check('로비 접속 시 열린 방 목록 수신');
    const N1 = new Client('작명'); await N1.open();
    await N1.expectError(() => N1.send({ t: 'create', nickname: '작명', roomName: '가'.repeat(21) }), /20자/); check('21자 방 이름 거부');
    N1.send({ t: 'create', nickname: '작명', roomName: '  금요일 라이어  ' });
    await N1.until((c) => c.state, 3000, 'named room');
    assert.equal(N1.state.roomName, '금요일 라이어'); check('방 이름 지정');
    const N2 = new Client('무명'); await N2.open();
    N2.send({ t: 'create', nickname: '무명' });
    await N2.until((c) => c.state, 3000, 'fish room');
    assert.ok(N2.state.roomName && N2.state.roomName !== '금요일 라이어');
    check(`방 이름 비우면 물고기 이름 자동 배정 (${N2.state.roomName})`);
    await L1.until((c) => c.rooms.length === baseCount + 2 && c.rooms.some((r) => r.name === '금요일 라이어'), 3000, 'list update');
    const listed = L1.rooms.find((r) => r.code === N1.code);
    assert.equal(listed.players, 1); assert.equal(listed.maxPlayers, 10); assert.equal(listed.inProgress, false);
    check('새 방이 로비 목록에 실시간 추가 (이름·인원·상태)');
    const N3 = new Client('합류'); await N3.open();
    N3.send({ t: 'join', code: N1.code, nickname: '합류' });
    await L1.until((c) => (c.rooms.find((r) => r.code === N1.code) || {}).players === 2, 3000, 'count update');
    check('참가자 수 변화가 로비 목록에 반영');
    N2.send({ t: 'leave' });
    await L1.until((c) => !c.rooms.some((r) => r.code === N2.code), 3000, 'room removed');
    check('모두 나간 방은 목록에서 사라짐');
    // 방에 들어간 연결은 더는 로비 목록을 받지 않음
    L1.send({ t: 'join', code: N1.code, nickname: '로비' });
    await L1.until((c) => c.state, 3000, 'lobby watcher joins');
    L1.rooms = 'stop';
    N3.send({ t: 'leave' });
    await sleep(500);
    assert.equal(L1.rooms, 'stop'); check('방에 들어가면 로비 목록 전송 중단');
    for (const c of [L1, N1, N3]) c.close();
    console.log(`\n모두 통과: ${ok}개 검사`);
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error('\n실패:', e); process.exit(1); });
