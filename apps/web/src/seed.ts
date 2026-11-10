import * as Shortcuts from '@axterm/plugin-api/shortcuts';
import * as Desktop from '@axterm/plugin-api/desktop';
import * as SessionIntents from '@axterm/plugin-api/session-intents';
import * as React from 'react';
import * as Jsx from 'react/jsx-runtime';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as Cordis from '@deepseek-ai/cordis';
import * as Zod from 'zod';
import * as Api from '@axterm/plugin-api';
import * as Engines from '@axterm/engine-api';
import * as Brand from '@axterm/plugin-api/brand';
import * as Credentials from '@axterm/plugin-api/credentials';
import * as ConfigurationSync from '@axterm/plugin-api/configuration-sync';
import * as ConfigurationPortable from '@axterm/plugin-api/configuration-portable';
import * as SavedCredentials from '@axterm/plugin-api/saved-credentials';
import * as Types from '@axterm/plugin-api/types';
import * as Info from '@axterm/plugin-api/remote-info';
import * as Streams from '@axterm/plugin-api/stream-protocol';
import * as Storage from '@axterm/plugin-api/storage';
import * as Terminals from '@axterm/plugin-api/terminals';
import * as Catalog from '@axterm/plugin-api/catalog';
import * as Configuration from '@axterm/plugin-api/configuration';
import * as Connections from '@axterm/plugin-api/connections';
import * as Files from '@axterm/plugin-api/files';
import * as Transfers from '@axterm/plugin-api/transfers';
import * as RemoteDesktop from '@axterm/plugin-api/remote-desktop';
import * as Automation from '@axterm/plugin-api/automation';
import * as Ai from '@axterm/plugin-api/ai';
import * as Plugins from '@axterm/plugin-api/plugins';
import * as Market from '@axterm/plugin-api/market';
import * as Ui from '@axterm/ui';
import * as Workspace from '@axterm/ui/workspace';
import * as Preference from '@axterm/ui/preference';
import * as Presentation from '@axterm/ui/presentation';
import * as Controls from '@axterm/ui/controls';
import * as Stores from '@axterm/ui/store-contract';
/** Static identities shared with every separately delivered Client factory. */
export function getStaticModules(): Record<string, unknown> {
  return {
    react: React,
    'react/jsx-runtime': Jsx,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    '@deepseek-ai/cordis': Cordis,
    zod: Zod,
    '@axterm/plugin-api': Api,
    '@axterm/plugin-api/session-intents': SessionIntents,
    '@axterm/engine-api': Engines,
    '@axterm/plugin-api/brand': Brand,
    '@axterm/plugin-api/credentials': Credentials,
    '@axterm/plugin-api/saved-credentials': SavedCredentials,
    '@axterm/plugin-api/configuration-portable': ConfigurationPortable,
    '@axterm/plugin-api/configuration-sync': ConfigurationSync,
    '@axterm/plugin-api/types': Types,
    '@axterm/plugin-api/remote-info': Info,
    '@axterm/plugin-api/stream-protocol': Streams,
    '@axterm/plugin-api/storage': Storage,
    '@axterm/plugin-api/terminals': Terminals,
    '@axterm/plugin-api/catalog': Catalog,
    '@axterm/plugin-api/configuration': Configuration,
    '@axterm/plugin-api/shortcuts': Shortcuts,
    '@axterm/plugin-api/connections': Connections,
    '@axterm/plugin-api/files': Files,
    '@axterm/plugin-api/transfers': Transfers,
    '@axterm/plugin-api/remote-desktop': RemoteDesktop,
    '@axterm/plugin-api/automation': Automation,
    '@axterm/plugin-api/ai': Ai,
    '@axterm/plugin-api/plugins': Plugins,
    '@axterm/plugin-api/market': Market,
    '@axterm/plugin-api/desktop': Desktop,
    '@axterm/ui': Ui,
    '@axterm/ui/workspace': Workspace,
    '@axterm/ui/store-contract': Stores,
    '@axterm/ui/controls': Controls,
    '@axterm/ui/presentation': Presentation,
    '@axterm/ui/preference': Preference,
  };
}
