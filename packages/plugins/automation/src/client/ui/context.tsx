import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { CatalogClientActions } from '@axterm/plugin-api/catalog';
import type { TerminalSessionsView } from '@axterm/plugin-api/terminals';
import type { WorkspaceUi } from '@axterm/ui/workspace';
import type { AutomationModel } from '../index.ts';
import type { AutomationUiCommands } from './commands.ts';
import type { QuickCommandRunner } from './quick-run.ts';
import type { AutomationTranslator } from './locales.ts';
export interface UiServices {
  model: AutomationModel;
  commands: AutomationUiCommands;
  catalog: CatalogClientActions;
  terminals: TerminalSessionsView;
  workspace: WorkspaceUi;
  runner: QuickCommandRunner;
}
const Services = createContext<UiServices | undefined>(undefined),
  Translation = createContext<AutomationTranslator | undefined>(undefined);
export function AutomationUi({
  services,
  translate,
  children,
}: {
  services: UiServices;
  translate: AutomationTranslator;
  children: ReactNode;
}) {
  return (
    <Services.Provider value={services}>
      <Translation.Provider value={translate}>{children}</Translation.Provider>
    </Services.Provider>
  );
}
export function useAutomation() {
  const services = useContext(Services);
  if (!services) throw Error('AUTOMATION_UI_UNAVAILABLE');
  return services;
}
export function useI18n() {
  const x = useContext(Translation);
  if (!x) throw Error('AUTOMATION_LOCALE_UNAVAILABLE');
  return { x };
}
export function useAutomationFacts() {
  const { model } = useAutomation();
  return useSyncExternalStore(model.subscribe, model.getSnapshot);
}
export function useTerminalTarget() {
  const { workspace, terminals } = useAutomation(),
    arrangement = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot),
    facts = useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);
  const session =
    facts.status === 'ready'
      ? facts.baseline.sessions.find((item) => item.id === arrangement.activeTabId)
      : undefined;
  return {
    session,
    target: session?.id,
    ready: !!session && session.state !== 'closed' && session.state !== 'failed',
  };
}
