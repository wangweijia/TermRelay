import type { SessionEventRecord, SessionRecord } from '../types';

const DATABASE_NAME = 'termrelay-web-cache';
const DATABASE_VERSION = 1;
const STORE_NAME = 'relay-state';
const SELECTED_SESSION_KEY = 'selected-session';
const SESSION_KEY_PREFIX = 'session:';

interface SelectedSessionRecord {
  key: typeof SELECTED_SESSION_KEY;
  sessionId: string;
}

interface SessionEventsRecord {
  key: string;
  sessionId: string;
  session?: SessionRecord;
  events: SessionEventRecord[];
  lastSeq: number;
  updatedAt: number;
}

export interface CachedSessionEvents {
  sessionId: string;
  session?: SessionRecord;
  events: SessionEventRecord[];
  lastSeq: number;
}

export async function loadSelectedSessionCache(): Promise<CachedSessionEvents | undefined> {
  const database = await openDatabase();
  const selected = await request<SelectedSessionRecord | undefined>(
    database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(SELECTED_SESSION_KEY),
  );
  if (!selected?.sessionId) return undefined;
  return loadSessionCache(selected.sessionId, database);
}

export async function loadSessionCache(
  sessionId: string,
  existingDatabase?: IDBDatabase,
): Promise<CachedSessionEvents | undefined> {
  const database = existingDatabase ?? await openDatabase();
  const cached = await request<SessionEventsRecord | undefined>(
    database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(sessionKey(sessionId)),
  );
  if (!cached) return undefined;
  return {
    sessionId: cached.sessionId,
    session: cached.session,
    events: cached.events,
    lastSeq: cached.lastSeq,
  };
}

export async function saveSelectedSession(sessionId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put({ key: SELECTED_SESSION_KEY, sessionId } satisfies SelectedSessionRecord);
  await transactionComplete(transaction);
}

export async function saveSessionCache(
  sessionId: string,
  session: SessionRecord | undefined,
  events: SessionEventRecord[],
  lastSeq: number,
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put({
    key: sessionKey(sessionId),
    sessionId,
    session,
    events,
    lastSeq,
    updatedAt: Date.now(),
  } satisfies SessionEventsRecord);
  await transactionComplete(transaction);
}

export async function deleteSessionCache(sessionId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.delete(sessionKey(sessionId));
  const selected = await request<SelectedSessionRecord | undefined>(store.get(SELECTED_SESSION_KEY));
  if (selected?.sessionId === sessionId) store.delete(SELECTED_SESSION_KEY);
  await transactionComplete(transaction);
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const openRequest = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    openRequest.addEventListener('upgradeneeded', () => {
      const database = openRequest.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' });
    });
    openRequest.addEventListener('success', () => resolve(openRequest.result));
    openRequest.addEventListener('error', () => reject(openRequest.error ?? new Error('无法打开浏览器缓存')));
  });
  return databasePromise;
}

function sessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.addEventListener('success', () => resolve(value.result));
    value.addEventListener('error', () => reject(value.error ?? new Error('浏览器缓存请求失败')));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('浏览器缓存事务被中止')));
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('浏览器缓存事务失败')));
  });
}
