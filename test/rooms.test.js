const test = require('node:test');
const assert = require('node:assert/strict');
const rooms = require('../src/rooms');

const NOW = 1_794_000_000_000;

/** Supabase stand-in: sessions maps bearer token -> { id, username }. */
function fakeSupabase(sessions) {
  return {
    auth: {
      async getUser(token) {
        const found = sessions[token];
        return found ? { data: { user: { id: found.id } }, error: null } : { data: { user: null }, error: { message: 'bad' } };
      },
    },
    from() {
      let id = null;
      const query = {
        select() { return query; },
        eq(_column, value) { id = value; return query; },
        async single() {
          const found = Object.values(sessions).find((session) => session.id === id);
          return found && found.username ? { data: { username: found.username }, error: null } : { data: null, error: { message: 'none' } };
        },
      };
      return query;
    },
  };
}

/** LiveKit stand-in that remembers rooms, their options and who is inside. */
function fakeLivekit(inside = {}) {
  const created = [];
  const state = new Map();
  return {
    created,
    inside,
    async createRoom(options) {
      created.push(options);
      if (!state.has(options.name)) state.set(options.name, options);
      return options;
    },
    async listParticipants(room) {
      return (inside[room] || []).map((identity) => ({ identity }));
    },
    async listRooms(names) {
      return names.filter((name) => state.has(name)).map((name) => state.get(name));
    },
  };
}

function deps(overrides = {}) {
  const issued = [];
  return {
    issued,
    supabase: fakeSupabase({
      'tok-rohan': { id: 'u1', username: 'rohan' },
      'tok-asha': { id: 'u2', username: 'asha' },
      'tok-eve': { id: 'u3', username: 'eve' },
      'tok-noprofile': { id: 'u4', username: null },
    }),
    livekit: fakeLivekit(),
    issueToken: async (identity, room) => { issued.push({ identity, room }); return `jwt:${identity}:${room}`; },
    now: () => NOW,
    cap: 12,
    randomHex: (bytes) => 'ab'.repeat(bytes),
    ...overrides,
  };
}

const asRohan = { authHeader: 'Bearer tok-rohan' };

test('a signed-in user gets a token for their own username and the server time', async () => {
  const d = deps();
  const result = await rooms.getToken({ ...d, ...asRohan, room: 'focus-room' });
  assert.deepEqual(result, { status: 200, body: { token: 'jwt:rohan:focus-room', serverTime: NOW } });
  assert.deepEqual(d.issued, [{ identity: 'rohan', room: 'focus-room' }]);
  assert.deepEqual(d.livekit.created, [{ name: 'focus-room', maxParticipants: 12, emptyTimeout: 300 }]);
});

test('a username sent by the client is ignored: the identity is always the session user', async () => {
  const d = deps();
  const result = await rooms.getToken({ ...d, ...asRohan, room: 'focus-room', username: 'asha' });
  assert.equal(result.status, 200);
  assert.equal(d.issued[0].identity, 'rohan');
});

test('a wrong, missing or profile-less session is refused before LiveKit is touched', async () => {
  for (const [authHeader, status, error] of [
    [undefined, 401, 'unauthorized'],
    ['Bearer nope', 401, 'invalid session'],
    ['Bearer tok-noprofile', 401, 'profile not found'],
  ]) {
    const d = deps();
    const result = await rooms.getToken({ ...d, authHeader, room: 'focus-room' });
    assert.deepEqual([result.status, result.body.error], [status, error]);
    assert.equal(d.livekit.created.length, 0);
    assert.equal(d.issued.length, 0);
  }
});

test('room names must be well formed', async () => {
  for (const room of [undefined, '', 'UPPER', 'a', '-lead', 'has space', 'x'.repeat(64), 'cub_short', '../etc']) {
    const d = deps();
    const result = await rooms.getToken({ ...d, ...asRohan, room });
    assert.equal(result.status, 400, String(room));
    assert.equal(d.issued.length, 0);
  }
  const ok = await rooms.getToken({ ...deps(), ...asRohan, room: 'x'.repeat(63) });
  assert.equal(ok.status, 200);
});

test('a full room answers 409 room_full and issues no token', async () => {
  const d = deps({ cap: 3, livekit: fakeLivekit({ 'focus-room': ['a', 'b', 'c'] }) });
  const result = await rooms.getToken({ ...d, ...asRohan, room: 'focus-room' });
  assert.deepEqual([result.status, result.body], [409, { error: 'room_full' }]);
  assert.equal(d.issued.length, 0);
});

test('someone already inside a full room can re-join', async () => {
  const d = deps({ cap: 3, livekit: fakeLivekit({ 'focus-room': ['a', 'rohan', 'c'] }) });
  const result = await rooms.getToken({ ...d, ...asRohan, room: 'focus-room' });
  assert.equal(result.status, 200);
  assert.equal(d.issued.length, 1);
});

test('the cap comes from the environment, defaulting to 12 and ignoring nonsense', () => {
  assert.equal(rooms.roomCap('20'), 20);
  assert.equal(rooms.roomCap(undefined), 12);
  assert.equal(rooms.roomCap('zero'), 12);
  assert.equal(rooms.roomCap('1'), 12);
});

async function withCubicle() {
  const d = deps({ livekit: fakeLivekit({ 'focus-room': ['rohan', 'asha', 'eve'] }) });
  const made = await rooms.createCubicle({ ...d, ...asRohan, room: 'focus-room', target: 'asha' });
  return { d, made };
}

test('a cubicle is created by the server for the two named people only', async () => {
  const { d, made } = await withCubicle();
  assert.equal(made.status, 200);
  assert.equal(made.body.cubicleRoomName, 'cub_' + 'ab'.repeat(12));
  assert.equal(made.body.token, `jwt:rohan:${made.body.cubicleRoomName}`);
  assert.equal(made.body.serverTime, NOW);
  assert.deepEqual(d.livekit.created.at(-1), {
    name: made.body.cubicleRoomName,
    maxParticipants: 2,
    emptyTimeout: 60,
    metadata: JSON.stringify({ members: ['rohan', 'asha'] }),
  });
});

test('a cubicle cannot be opened with someone who is not in the room, or by someone who is not', async () => {
  const d = deps({ livekit: fakeLivekit({ 'focus-room': ['rohan', 'asha'] }) });
  const absentTarget = await rooms.createCubicle({ ...d, ...asRohan, room: 'focus-room', target: 'eve' });
  assert.deepEqual([absentTarget.status, absentTarget.body.error], [403, 'both people must be in the room']);
  const outsider = await rooms.createCubicle({ ...d, authHeader: 'Bearer tok-eve', room: 'focus-room', target: 'asha' });
  assert.equal(outsider.status, 403);
  const toSelf = await rooms.createCubicle({ ...d, ...asRohan, room: 'focus-room', target: 'rohan' });
  assert.equal(toSelf.status, 400);
  assert.equal(d.livekit.created.length, 0);
  assert.equal(d.issued.length, 0);
});

test('the invited person gets a cubicle token, a third person does not', async () => {
  const { d, made } = await withCubicle();
  const name = made.body.cubicleRoomName;
  const invited = await rooms.getToken({ ...d, authHeader: 'Bearer tok-asha', room: name });
  assert.deepEqual([invited.status, invited.body.token], [200, `jwt:asha:${name}`]);
  const third = await rooms.getToken({ ...d, authHeader: 'Bearer tok-eve', room: name });
  assert.deepEqual([third.status, third.body.error], [403, 'not a member of this cubicle']);
  assert.ok(!d.issued.some((entry) => entry.identity === 'eve'));
});

test('a cubicle name that was never created gets no token, and is never created by asking', async () => {
  const d = deps();
  const result = await rooms.getToken({ ...d, ...asRohan, room: 'cub_' + 'cd'.repeat(12) });
  assert.equal(result.status, 403);
  assert.equal(d.livekit.created.length, 0);
});

test('a cubicle with unreadable metadata admits nobody', async () => {
  const d = deps();
  d.livekit.listRooms = async () => [{ name: 'cub_' + 'ef'.repeat(12), metadata: '{not json' }];
  const result = await rooms.getToken({ ...d, ...asRohan, room: 'cub_' + 'ef'.repeat(12) });
  assert.equal(result.status, 403);
});
