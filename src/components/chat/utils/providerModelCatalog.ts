import type {
  LLMProvider,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
} from '../../../types/app';

export type ProviderModelCatalogEntry = {
  models: ProviderModelsDefinition;
  cache: ProviderModelsCacheInfo;
};

/**
 * Loads provider catalogs concurrently while publishing each successful
 * result immediately. One unavailable provider must not hold back catalogs
 * that the backend has already returned for the other providers.
 */
export async function loadProviderModelCatalogEntries(
  providers: readonly LLMProvider[],
  loadEntry: (provider: LLMProvider) => Promise<ProviderModelCatalogEntry | null>,
  publishEntry: (provider: LLMProvider, entry: ProviderModelCatalogEntry) => void,
): Promise<void> {
  await Promise.allSettled(
    providers.map(async (provider) => {
      const entry = await loadEntry(provider);
      if (entry) {
        publishEntry(provider, entry);
      }
    }),
  );
}
