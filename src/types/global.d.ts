export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    cloudcliPerformance?: {
      capture(): Promise<string>;
      readonly latestReport: string | null;
    };
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
