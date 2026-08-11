export const EDITOR_RECOVERY_DB_NAME = 'cloudcli-editor-recovery';
export const EDITOR_RECOVERY_DB_VERSION = 1;
export const EDITOR_RECOVERY_STORE = 'documents';
export const EDITOR_RECOVERY_LIMIT = 50;

export type EditorRecoveryRecord = {
  accountId: string;
  projectId: string;
  filePath: string;
  content: string;
  baseline: string;
  updatedAt: number;
};

type EditorRecoveryStoreOptions = { indexedDB?: IDBFactory | null; dbName?: string };

export class EditorRecoveryStore {
  private readonly factory?: IDBFactory;
  private readonly dbName: string;
  private databasePromise: Promise<IDBDatabase | null> | null = null;

  constructor(options: EditorRecoveryStoreOptions = {}) {
    this.factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB ?? undefined;
    this.dbName = options.dbName ?? EDITOR_RECOVERY_DB_NAME;
  }

  private open(): Promise<IDBDatabase | null> {
    if (!this.factory) return Promise.resolve(null);
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory!.open(this.dbName, EDITOR_RECOVERY_DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(EDITOR_RECOVERY_STORE)) {
          const store = database.createObjectStore(EDITOR_RECOVERY_STORE, {
            keyPath: ['accountId', 'projectId', 'filePath'],
          });
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return this.databasePromise;
  }

  private async transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    const database = await this.open();
    if (!database) return null;
    return new Promise((resolve) => {
      try {
        const request = operation(database.transaction(EDITOR_RECOVERY_STORE, mode).objectStore(EDITOR_RECOVERY_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  get(accountId: string, projectId: string, filePath: string) {
    return this.transaction<EditorRecoveryRecord>('readonly', (store) => store.get([accountId, projectId, filePath]));
  }

  async put(record: EditorRecoveryRecord): Promise<void> {
    await this.transaction('readwrite', (store) => store.put(record));
    const records = await this.transaction<EditorRecoveryRecord[]>('readonly', (store) => store.getAll());
    if (!records || records.length <= EDITOR_RECOVERY_LIMIT) return;
    const overflow = records
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, records.length - EDITOR_RECOVERY_LIMIT);
    await Promise.all(overflow.map((entry) => this.delete(entry.accountId, entry.projectId, entry.filePath)));
  }

  async delete(accountId: string, projectId: string, filePath: string): Promise<void> {
    await this.transaction('readwrite', (store) => store.delete([accountId, projectId, filePath]));
  }
}

export const editorRecoveryStore = new EditorRecoveryStore();
