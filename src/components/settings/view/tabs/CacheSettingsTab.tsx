import { useCallback, useEffect, useState } from 'react';
import { Database, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useSessionStoreContext } from '../../../../stores/sessionStoreContext';
import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

type CacheStats = {
  sessionCount: number;
  messageCount: number;
};

type SyncState = 'idle' | 'pending' | 'success' | 'partial' | 'error';
type ClearState = 'idle' | 'pending' | 'success' | 'error';

const EMPTY_STATS: CacheStats = { sessionCount: 0, messageCount: 0 };

export default function CacheSettingsTab() {
  const { t } = useTranslation('settings');
  const { getCacheStats, forceSyncCache, clearCache, cacheStorageStatus, refreshCacheStorageStatus } = useSessionStoreContext();
  const [stats, setStats] = useState<CacheStats>(EMPTY_STATS);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [syncCounts, setSyncCounts] = useState({ eligible: 0, succeeded: 0, failed: 0 });
  const [clearState, setClearState] = useState<ClearState>('idle');
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const refreshStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(false);
    try {
      setStats(await getCacheStats());
    } catch {
      setStatsError(true);
    } finally {
      setStatsLoading(false);
    }
  }, [getCacheStats]);

  useEffect(() => {
    void refreshStats();
    void refreshCacheStorageStatus(false);
  }, [refreshStats, refreshCacheStorageStatus]);

  const formatBytes = (value: number | null) => value === null ? t('cache.unknown') : new Intl.NumberFormat(undefined, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(value / 1_000_000);

  const isBusy = syncState === 'pending' || clearState === 'pending';

  const handleSync = async () => {
    if (isBusy) return;
    setSyncState('pending');
    try {
      const result = await forceSyncCache();
      setSyncCounts({
        eligible: result.eligible,
        succeeded: result.succeeded,
        failed: result.failed,
      });
      if (result.success && result.failed === 0) {
        setSyncState('success');
      } else if (result.manifestValid && result.failed > 0) {
        setSyncState('partial');
      } else {
        setSyncState('error');
      }
      await refreshStats();
    } catch {
      setSyncState('error');
      await refreshStats();
    }
  };

  const handleClear = async () => {
    if (isBusy) return;
    setClearState('pending');
    try {
      const result = await clearCache();
      setStats(result.stats);
      setStatsError(false);
      if (result.success && result.stats.sessionCount === 0 && result.stats.messageCount === 0) {
        setClearState('success');
        setClearDialogOpen(false);
      } else {
        setClearState('error');
        await refreshStats();
      }
    } catch {
      setClearState('error');
      await refreshStats();
    }
  };

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="flex items-center gap-3">
        <Database className="h-5 w-5 text-blue-600" aria-hidden="true" />
        <div>
          <h3 className="text-lg font-medium text-foreground">{t('cache.title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('cache.description')}</p>
        </div>
      </div>

      <SettingsSection title={t('cache.statsTitle')} description={t('cache.statsDescription')}>
        <SettingsCard divided>
          {statsLoading ? (
            <div className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('cache.loading')}
            </div>
          ) : statsError ? (
            <div className="px-4 py-5 text-sm text-destructive" role="alert">
              {t('cache.loadError')}
            </div>
          ) : (
            <>
              <SettingsRow label={t('cache.sessionCountLabel')}>
                <span className="font-mono text-sm text-foreground" data-testid="cache-session-count">
                  {stats.sessionCount}
                </span>
              </SettingsRow>
              <SettingsRow label={t('cache.messageCountLabel')}>
                <span className="font-mono text-sm text-foreground" data-testid="cache-message-count">
                  {stats.messageCount}
                </span>
              </SettingsRow>
              <SettingsRow label={t('cache.usageLabel')}><span data-testid="cache-storage-usage">{formatBytes(cacheStorageStatus.usage)} / {formatBytes(cacheStorageStatus.quota)}</span></SettingsRow>
              <SettingsRow label={t('cache.persistenceLabel')}><span data-testid="cache-persistence-status">{t(`cache.persistence.${cacheStorageStatus.persistence}`)}</span></SettingsRow>
              <SettingsRow label={t('cache.statusLabel')}><span data-testid="cache-failure-status">{t(`cache.status.${cacheStorageStatus.failure}`)}</span></SettingsRow>
            </>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('cache.syncSectionTitle')} description={t('cache.syncDescription')}>
        <SettingsCard>
          <SettingsRow label={t('cache.syncButton')}>
            <Button type="button" variant="outline" onClick={() => { void handleSync(); }} disabled={isBusy}>
              {syncState === 'pending' ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              {syncState === 'pending' ? t('cache.syncPending') : t('cache.syncButton')}
            </Button>
          </SettingsRow>
          {syncState === 'success' && (
            <p className="px-4 pb-4 text-sm text-green-600 dark:text-green-400" role="status">
              {t('cache.syncSuccess', syncCounts)}
            </p>
          )}
          {syncState === 'partial' && (
            <p className="px-4 pb-4 text-sm text-amber-600 dark:text-amber-400" role="status">
              {t('cache.syncPartial', syncCounts)}
            </p>
          )}
          {syncState === 'error' && (
            <p className="px-4 pb-4 text-sm text-destructive" role="alert">
              {t('cache.syncError')}
            </p>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('cache.clearSectionTitle')} description={t('cache.clearDescription')}>
        <SettingsCard>
          <SettingsRow label={t('cache.clearButton')}>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setClearDialogOpen(true)}
              disabled={isBusy}
            >
              <Trash2 aria-hidden="true" />
              {t('cache.clearButton')}
            </Button>
          </SettingsRow>
          {clearState === 'success' && (
            <p className="px-4 pb-4 text-sm text-green-600 dark:text-green-400" role="status">
              {t('cache.clearSuccess')}
            </p>
          )}
          {clearState === 'error' && (
            <p className="px-4 pb-4 text-sm text-destructive" role="alert">
              {t('cache.clearError')}
            </p>
          )}
        </SettingsCard>
      </SettingsSection>

      <Dialog open={clearDialogOpen} onOpenChange={(open) => !clearState.includes('pending') && setClearDialogOpen(open)}>
        <DialogContent
          className="p-6"
          wrapperClassName="z-[10000]"
          aria-labelledby="cache-confirmation-title"
          aria-describedby="cache-confirmation-description"
        >
          <DialogTitle id="cache-confirmation-title">{t('cache.confirmationTitle')}</DialogTitle>
          <div className="space-y-4">
            <h2 className="text-base font-semibold text-foreground" aria-hidden="true">{t('cache.confirmationTitle')}</h2>
            <p id="cache-confirmation-description" className="text-sm text-muted-foreground">{t('cache.confirmationDescription')}</p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setClearDialogOpen(false)}
                disabled={clearState === 'pending'}
              >
                {t('cache.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => { void handleClear(); }}
                disabled={clearState === 'pending' || syncState === 'pending'}
              >
                {clearState === 'pending' && <Loader2 className="animate-spin" aria-hidden="true" />}
                {clearState === 'pending' ? t('cache.clearPending') : t('cache.confirm')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
