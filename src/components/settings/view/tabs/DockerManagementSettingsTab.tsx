import { useEffect, useRef, useState } from 'react';
import { Container, FileText, Hammer, Loader2, Power, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { appendBoundedDockerLogs, requestDockerBuild, requestDockerDown, requestDockerRestart, streamDockerLogs } from '../../services/dockerManagementApi';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

type ActionState = 'idle' | 'pending' | 'accepted' | 'error';
type Action = 'build' | 'restart' | 'down';

export default function DockerManagementSettingsTab() {
  const { t } = useTranslation('settings');
  const [buildState, setBuildState] = useState<ActionState>('idle');
  const [restartState, setRestartState] = useState<ActionState>('idle');
  const [downState, setDownState] = useState<ActionState>('idle');
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState('');
  const [logsState, setLogsState] = useState<'connecting' | 'connected' | 'ended' | 'error'>('connecting');
  const logsViewportRef = useRef<HTMLPreElement>(null);
  const followingRef = useRef(true);
  const isBusy = buildState === 'pending' || restartState === 'pending' || downState === 'pending';

  useEffect(() => {
    if (!logsOpen) return undefined;
    const controller = new AbortController();
    followingRef.current = true;
    setLogsState('connecting');
    void streamDockerLogs(
      (chunk) => {
        setLogsState('connected');
        setLogs((current) => appendBoundedDockerLogs(current, chunk));
      },
      controller.signal,
    ).then(() => setLogsState('ended')).catch(() => {
      if (!controller.signal.aborted) setLogsState('error');
    });
    return () => controller.abort();
  }, [logsOpen]);

  useEffect(() => {
    if (followingRef.current && logsViewportRef.current) {
      logsViewportRef.current.scrollTop = logsViewportRef.current.scrollHeight;
    }
  }, [logs]);

  const runAction = async (action: Action) => {
    if (isBusy) return;
    const actions = {
      build: { request: requestDockerBuild, setState: setBuildState },
      restart: { request: requestDockerRestart, setState: setRestartState },
      down: { request: requestDockerDown, setState: setDownState },
    };
    const { request, setState } = actions[action];
    setState('pending');
    try {
      await request();
      setState('accepted');
    } catch {
      setState('error');
    }
  };

  const feedback = (action: Action, state: ActionState) => {
    if (state === 'idle' || state === 'pending') return null;
    return (
      <p
        className={`px-4 pb-4 text-sm ${state === 'error' ? 'text-destructive' : 'text-green-600 dark:text-green-400'}`}
        role={state === 'error' ? 'alert' : 'status'}
      >
        {t(`dockerManagement.${action}.${state}`)}
      </p>
    );
  };

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="flex items-center gap-3">
        <Container className="h-5 w-5 text-blue-600" aria-hidden="true" />
        <div>
          <h3 className="text-lg font-medium text-foreground">{t('dockerManagement.title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('dockerManagement.description')}</p>
        </div>
      </div>

      <SettingsSection title={t('dockerManagement.actionsTitle')} description={t('dockerManagement.actionsDescription')}>
        <SettingsCard divided>
          <div>
            <SettingsRow label={t('dockerManagement.build.label')} description={t('dockerManagement.build.description')}>
              <Button type="button" variant="outline" disabled={isBusy} onClick={() => { void runAction('build'); }}>
                {buildState === 'pending' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Hammer aria-hidden="true" />}
                {buildState === 'pending' ? t('dockerManagement.build.pending') : t('dockerManagement.build.action')}
              </Button>
            </SettingsRow>
            {feedback('build', buildState)}
          </div>
          <div>
            <SettingsRow label={t('dockerManagement.restart.label')} description={t('dockerManagement.restart.description')}>
              <Button type="button" variant="destructive" disabled={isBusy} onClick={() => { void runAction('restart'); }}>
                {restartState === 'pending' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                {restartState === 'pending' ? t('dockerManagement.restart.pending') : t('dockerManagement.restart.action')}
              </Button>
            </SettingsRow>
            {feedback('restart', restartState)}
          </div>
          <div>
            <SettingsRow label={t('dockerManagement.down.label')} description={t('dockerManagement.down.description')}>
              <Button type="button" variant="destructive" disabled={isBusy} onClick={() => { void runAction('down'); }}>
                {downState === 'pending' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Power aria-hidden="true" />}
                {downState === 'pending' ? t('dockerManagement.down.pending') : t('dockerManagement.down.action')}
              </Button>
            </SettingsRow>
            {feedback('down', downState)}
          </div>
          <SettingsRow label={t('dockerManagement.logs.label')} description={t('dockerManagement.logs.description')}>
            <Button type="button" variant="outline" onClick={() => setLogsOpen(true)}>
              <FileText aria-hidden="true" />
              {t('dockerManagement.logs.action')}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent aria-labelledby="docker-logs-title" className="flex h-[min(80vh,44rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col overflow-hidden p-0">
          <header className="border-b px-5 py-4">
            <DialogTitle id="docker-logs-title" className="not-sr-only text-lg font-semibold">{t('dockerManagement.logs.title')}</DialogTitle>
            <p className="mt-1 text-sm text-muted-foreground" role={logsState === 'error' ? 'alert' : 'status'} aria-live="polite">
              {t(`dockerManagement.logs.${logsState}`)}
            </p>
          </header>
          <pre
            ref={logsViewportRef}
            className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-zinc-950 p-4 font-mono text-xs text-zinc-100"
            tabIndex={0}
            onScroll={(event) => {
              const element = event.currentTarget;
              followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
            }}
          >
            {logs || t('dockerManagement.logs.empty')}
          </pre>
          <footer className="flex justify-end gap-2 border-t px-5 py-3">
            <Button type="button" variant="outline" onClick={() => setLogs('')}>{t('dockerManagement.logs.clear')}</Button>
            <Button type="button" onClick={() => setLogsOpen(false)}>{t('dockerManagement.logs.close')}</Button>
          </footer>
        </DialogContent>
      </Dialog>
    </div>
  );
}
