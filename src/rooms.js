/**
 * Room tokens and cubicles (B1-B3).
 *
 * Every handler takes the LiveKit room-service client and the Supabase client as
 * arguments and returns { status, body }, so the rules can be tested without a
 * network. server.js wires them to Express.
 *
 * livekit: { createRoom(opts), listParticipants(room), listRooms(names) }
 * supabase: the service-role client (auth.getUser, from('profiles'))
 * issueToken: async (identity, room) => jwt string
 */

const ROOM_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CUBICLE_NAME = /^cub_[0-9a-f]{24}$/;
const DEFAULT_ROOM_CAP = 12;
const ROOM_EMPTY_TIMEOUT_SECONDS = 300;
const CUBICLE_EMPTY_TIMEOUT_SECONDS = 60;

function reply(status, body) {
  return { status, body };
}

function roomCap(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 2 ? parsed : DEFAULT_ROOM_CAP;
}

/** The profile username behind a bearer token, or a ready { status, body } refusal. */
async function whoIs(supabase, authHeader) {
  if (!authHeader) return { refusal: reply(401, { error: 'unauthorized' }) };
  const sessionToken = authHeader.replace('Bearer ', '');
  const { data, error } = await supabase.auth.getUser(sessionToken);
  const user = data && data.user;
  if (error || !user) return { refusal: reply(401, { error: 'invalid session' }) };

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', user.id)
    .single();
  if (profileError || !profile || !profile.username) return { refusal: reply(401, { error: 'profile not found' }) };
  return { username: profile.username };
}

async function identitiesIn(livekit, room) {
  const participants = await livekit.listParticipants(room);
  return participants.map((participant) => participant.identity);
}

function membersOf(room) {
  try {
    const parsed = JSON.parse(room.metadata || '{}');
    return Array.isArray(parsed.members) ? parsed.members.filter((member) => typeof member === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * POST /getToken { room }  (GET ?room= still works for one release).
 * The identity is always the session's username; any username in the request is ignored.
 */
async function getToken({ authHeader, room, supabase, livekit, issueToken, now, cap }) {
  if (typeof room !== 'string' || room.length === 0) return reply(400, { error: 'room is required' });
  const isCubicle = CUBICLE_NAME.test(room);
  if (!isCubicle && !ROOM_NAME.test(room)) return reply(400, { error: 'invalid room name' });

  const who = await whoIs(supabase, authHeader);
  if (who.refusal) return who.refusal;
  const { username } = who;

  if (isCubicle) {
    const found = await livekit.listRooms([room]);
    const cubicle = found && found[0];
    // A cubicle exists only for the two people the server named when it created it.
    if (!cubicle || !membersOf(cubicle).includes(username)) return reply(403, { error: 'not a member of this cubicle' });
  } else {
    // Creating a room that exists is a no-op, so this is safe to call on every join.
    await livekit.createRoom({ name: room, maxParticipants: cap, emptyTimeout: ROOM_EMPTY_TIMEOUT_SECONDS });
    const inside = await identitiesIn(livekit, room);
    // Someone already inside may re-join (a refresh); anyone else is turned away at the cap.
    if (inside.length >= cap && !inside.includes(username)) return reply(409, { error: 'room_full' });
  }

  const token = await issueToken(username, room);
  return reply(200, { token, serverTime: now() });
}

/** POST /cubicle { room, target } - a private two-person room inside a room both people are in. */
async function createCubicle({ authHeader, room, target, supabase, livekit, issueToken, now, randomHex }) {
  if (typeof room !== 'string' || !ROOM_NAME.test(room)) return reply(400, { error: 'invalid room name' });
  if (typeof target !== 'string' || target.length === 0 || target.length > 64) return reply(400, { error: 'target is required' });

  const who = await whoIs(supabase, authHeader);
  if (who.refusal) return who.refusal;
  const { username } = who;
  if (target === username) return reply(400, { error: 'cannot open a cubicle with yourself' });

  const inside = await identitiesIn(livekit, room);
  if (!inside.includes(username) || !inside.includes(target)) {
    return reply(403, { error: 'both people must be in the room' });
  }

  const cubicleRoomName = 'cub_' + randomHex(12);
  await livekit.createRoom({
    name: cubicleRoomName,
    maxParticipants: 2,
    emptyTimeout: CUBICLE_EMPTY_TIMEOUT_SECONDS,
    metadata: JSON.stringify({ members: [username, target] }),
  });
  const token = await issueToken(username, cubicleRoomName);
  return reply(200, { cubicleRoomName, token, serverTime: now() });
}

module.exports = {
  ROOM_NAME,
  CUBICLE_NAME,
  DEFAULT_ROOM_CAP,
  roomCap,
  getToken,
  createCubicle,
};
