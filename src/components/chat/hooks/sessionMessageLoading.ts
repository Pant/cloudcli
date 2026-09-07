export interface SessionMessageLoadToken {
  readonly generation: number;
  readonly identityKey: string;
}

export interface SessionMessageLoadingOwner {
  begin: (identityKey: string) => SessionMessageLoadToken;
  invalidate: () => void;
  isCurrent: (token: SessionMessageLoadToken, identityKey: string) => boolean;
}

export interface ExternalSessionRefreshOwner {
  select: (identityKey: string | null, revision: number) => void;
  consume: (identityKey: string, revision: number, active: boolean) => boolean;
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

export function createExternalSessionRefreshOwner(): ExternalSessionRefreshOwner {
  let selectedIdentityKey: string | null = null;
  let consumedRevision = 0;

  return {
    select(identityKey, revision) {
      if (identityKey === selectedIdentityKey) return;
      selectedIdentityKey = identityKey;
      consumedRevision = revision;
    },
    consume(identityKey, revision, active) {
      if (identityKey !== selectedIdentityKey || revision <= consumedRevision) return false;
      consumedRevision = revision;
      return !active;
    },
  };
}
