import { useState } from 'react';
import { Container, Hammer, Loader2, Power, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';
import { requestDockerBuild, requestDockerDown, requestDockerRestart } from '../../services/dockerManagementApi';
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
  const isBusy = buildState === 'pending' || restartState === 'pending' || downState === 'pending';

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
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
