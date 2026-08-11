export type ChatImageBlobCacheDependencies = {
  fetchBlob: (url: string, signal: AbortSignal) => Promise<Blob | null>;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
};

type BlobEntry = {
  refs: number;
  objectUrl: string | null;
  promise: Promise<string>;
  controller: AbortController;
};

/** Shared by ChatMessageImages so repeated visible paths use one authenticated request and URL. */
export function createChatImageBlobCache(dependencies: ChatImageBlobCacheDependencies) {
  const entries = new Map<string, BlobEntry>();

  async function fetchFirstBlob(urls: string[], signal: AbortSignal): Promise<string> {
    for (const url of urls) {
      try {
        const blob = await dependencies.fetchBlob(url, signal);
        if (blob) return dependencies.createObjectUrl(blob);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
      }
    }
    throw new Error('Image unavailable');
  }

  return {
    acquire(key: string, urls: string[]): { promise: Promise<string>; release: () => void } {
      let entry = entries.get(key);
      if (!entry) {
        const controller = new AbortController();
        entry = { refs: 0, objectUrl: null, controller, promise: fetchFirstBlob(urls, controller.signal) };
        const createdEntry = entry;
        createdEntry.promise = createdEntry.promise.then((objectUrl) => {
          createdEntry.objectUrl = objectUrl;
          if (createdEntry.refs === 0) {
            dependencies.revokeObjectUrl(objectUrl);
            entries.delete(key);
          }
          return objectUrl;
        }).catch((error) => {
          entries.delete(key);
          throw error;
        });
        entries.set(key, createdEntry);
      }
      entry.refs += 1;
      let released = false;
      return {
        promise: entry.promise,
        release: () => {
          if (released) return;
          released = true;
          entry!.refs -= 1;
          if (entry!.refs === 0) {
            if (entry!.objectUrl) dependencies.revokeObjectUrl(entry!.objectUrl);
            else entry!.controller.abort();
            entries.delete(key);
          }
        },
      };
    },
    size: () => entries.size,
  };
}
