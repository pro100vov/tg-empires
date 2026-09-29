import { dataFile, readJsonSafe, writeJsonAtomic } from './storage.js';

/**
 * Реестр игроков для уведомлений бота. Бот может писать только тем, кто нажал /start
 * или разрешил писать в личку, поэтому помним, кому писать можно и кто отключил сообщения.
 */
export interface UserRecord {
  id: string;
  name: string;
  /** Бот может писать этому игроку в личку. */
  canNotify: boolean;
  /** Игрок не отключил уведомления (/notify off). */
  notify: boolean;
  /** Последнее сообщение «ваш ход» по каждой партии — чтобы удалять старое. */
  turnMsgs: Record<string, number>;
}

const users = new Map<string, UserRecord>();
let dirty = false;

interface SavedUsers {
  version: 1;
  users: UserRecord[];
}

const SAVE_EVERY_MS = 10_000;

export function loadUsers(): void {
  const saved = readJsonSafe<SavedUsers>(dataFile('users.json'));
  if (!saved || !Array.isArray(saved.users)) return;
  for (const u of saved.users) {
    if (u?.id) users.set(u.id, { ...u, turnMsgs: u.turnMsgs ?? {}, notify: u.notify !== false, canNotify: u.canNotify === true });
  }
  console.log(`[users] игроков в реестре: ${users.size}`);
}

export function saveUsers(force = false): void {
  if (!dirty && !force) return;
  try {
    writeJsonAtomic(dataFile('users.json'), { version: 1, users: [...users.values()] } satisfies SavedUsers);
    dirty = false;
  } catch (err) {
    console.error('[users] не удалось сохранить:', err);
  }
}

export function startUsersAutosave(): NodeJS.Timeout {
  return setInterval(() => saveUsers(), SAVE_EVERY_MS);
}

/** Запоминает игрока. `canNotify` меняем, только если он передан явно. */
export function touchUser(id: string, name: string, canNotify?: boolean): UserRecord {
  let rec = users.get(id);
  if (!rec) {
    rec = { id, name, canNotify: false, notify: true, turnMsgs: {} };
    users.set(id, rec);
    dirty = true;
  }
  if (name && rec.name !== name) {
    rec.name = name;
    dirty = true;
  }
  if (canNotify !== undefined && rec.canNotify !== canNotify) {
    rec.canNotify = canNotify;
    dirty = true;
  }
  return rec;
}

export function getUser(id: string): UserRecord | undefined {
  return users.get(id);
}

export function setNotify(id: string, notify: boolean): void {
  const rec = users.get(id);
  if (rec && rec.notify !== notify) {
    rec.notify = notify;
    dirty = true;
  }
}

/** Можно ли слать этому игроку уведомления. */
export function mayNotify(id: string): boolean {
  const rec = users.get(id);
  return Boolean(rec?.canNotify && rec.notify);
}

export function setTurnMsg(id: string, roomCode: string, messageId: number | null): void {
  const rec = users.get(id);
  if (!rec) return;
  if (messageId == null) delete rec.turnMsgs[roomCode];
  else rec.turnMsgs[roomCode] = messageId;
  dirty = true;
}
