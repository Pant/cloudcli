export interface SessionMessageLoadToken {
  readonly generation: number;
  readonly identityKey: string;
}

export interface SessionMessageLoadingOwner {
  begin: (identityKey: string) => SessionMessageLoadToken;
  invalidate: () => void;
  isCurrent: (token: SessionMessageLoadToken, identityKey: string) => boolean;
}

export function shouldBlockSessionMessageDisplay(args: {
  hasDisplayableMessages: boolean;
  isCanonicalLoading: boolean;
}): boolean {
  return !args.hasDisplayableMessages && args.isCanonicalLoading;
}

export function createSessionMessageLoadingOwner(): SessionMessageLoadingOwner {
  let generation = 0;

  return {
    begin(identityKey) {
      generation += 1;
      return { generation, identityKey };
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(token, identityKey) {
      return token.generation === generation && token.identityKey === identityKey;
    },
  };
}
