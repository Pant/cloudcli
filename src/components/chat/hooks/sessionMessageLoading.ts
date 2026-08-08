export interface SessionMessageLoadToken {
  readonly generation: number;
}

export interface SessionMessageLoadingOwner {
  begin: () => SessionMessageLoadToken;
  invalidate: () => void;
  isCurrent: (token: SessionMessageLoadToken) => boolean;
}

export function createSessionMessageLoadingOwner(): SessionMessageLoadingOwner {
  let generation = 0;

  return {
    begin() {
      generation += 1;
      return { generation };
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(token) {
      return token.generation === generation;
    },
  };
}
