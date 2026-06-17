// Socket.IO event names exchanged with arena clients (see sockets/arenaSocket.js).

// Connection lifecycle (Socket.IO built-ins).
export const CONNECTION = "connection";
export const DISCONNECT = "disconnect";

// server → client
export const SESSION = "session";
export const ARENA_QUESTION = "arena:question";
export const ARENA_RESULT = "arena:result";
export const ARENA_ONLINE = "arena:online";

// client → server (each takes an ack callback)
export const ARENA_JOIN = "arena:join";
export const ARENA_ANSWER = "arena:answer";
export const ARENA_SYNC = "arena:sync";
export const ARENA_LEAVE = "arena:leave";
