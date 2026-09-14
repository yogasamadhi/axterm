import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { FileRenamePreview, StartMcpServerInput, WidgetInstance } from '@workspace/contracts';
import type { FileGrant } from '@workspace/contracts/desktop';
import {
  Check,
  Copy,
  ExternalLink,
  FolderOpen,
  KeyRound,
  Pencil,
  Play,
  Search,
  Server,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import { useI18n } from '../../i18n/context';
import './widget-workspace.css';

type Client = ReturnType<typeof createRuntimeClient>;
type Notice = { tone: 'success' | 'error'; title: string; description: string };

export function WidgetWorkspace({ client }: { client: Client }) {
  const { x } = useI18n();
  const catalog = useQuery({ queryKey: ['widgets'], queryFn: client.widgets });
  const instances = useQuery({
    queryKey: ['widget-instances'],
    queryFn: client.widgetInstances,
    refetchInterval: 2_000,
  });
  const [tab, setTab] = useState<'widgets' | 'instances'>('widgets');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('local-file-server');
  const [grant, setGrant] = useState<FileGrant>();
  const [notice, setNotice] = useState<Notice>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 10_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const visibleWidgets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (catalog.data ?? []).filter(
      (widget) =>
        !normalized ||
        widgetName(widget.id, widget.name, x).toLocaleLowerCase().includes(normalized) ||
        widgetDescription(widget.id, widget.description, x)
          .toLocaleLowerCase()
          .includes(normalized),
    );
  }, [catalog.data, query, x]);

  async function selectDirectory() {
    try {
      const selected = await client.createFileGrant('open-directory');
      if (selected) setGrant(selected);
    } catch (cause) {
      setNotice({
        tone: 'error',
        title: x('widgets.chooseDirectoryFailed'),
        description: messageOf(cause, x),
      });
    }
  }

  async function startFileServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!grant) {
      setNotice({
        tone: 'error',
        title: x('widgets.noDirectory'),
        description: x('widgets.grantDirectoryFirst'),
      });
      return;
    }
    const form = new FormData(event.currentTarget);
    setStarting(true);
    try {
      const instance = await client.startLocalFileServerWidget({
        grantId: grant.grantId,
        title: stringValue(form, 'title'),
        host: stringValue(form, 'host'),
        port: numberValue(form, 'port'),
        index: stringValue(form, 'index'),
        dotfiles: stringValue(form, 'dotfiles') as 'allow' | 'deny' | 'ignore',
        cacheControl: form.get('cacheControl') === 'on',
        maxAgeMs: numberValue(form, 'maxAgeMs'),
        lastModified: form.get('lastModified') === 'on',
        etag: form.get('etag') === 'on',
        acceptRanges: form.get('acceptRanges') === 'on',
        redirect: form.get('redirect') === 'on',
      });
      await instances.refetch();
      setTab('instances');
      setNotice({
        tone: 'success',
        title: x('widgets.fileServerStarted'),
        description: `${instance.serverInfo?.url ?? ''} · ${instance.serverInfo?.rootName ?? ''}`,
      });
    } catch (cause) {
      setNotice({
        tone: 'error',
        title: x('widgets.startFailed'),
        description: messageOf(cause, x),
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="widget-workspace">
      <aside className="widget-sidebar">
        <div className="widget-sidebar-tabs" role="tablist" aria-label={x('widgets.list')}>
          <button
            className={tab === 'widgets' ? 'active' : ''}
            aria-selected={tab === 'widgets'}
            role="tab"
            type="button"
            onClick={() => setTab('widgets')}
          >
            {x('widgets.title')}
          </button>
          <button
            className={tab === 'instances' ? 'active' : ''}
            aria-selected={tab === 'instances'}
            role="tab"
            type="button"
            onClick={() => setTab('instances')}
          >
            {x('widgets.runningCount', { count: instances.data?.length ?? 0 })}
          </button>
        </div>
        {tab === 'widgets' ? (
          <>
            <label className="widget-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label={x('widgets.search')}
                placeholder={x('widgets.searchPlaceholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="widget-list" role="listbox" aria-label={x('widgets.builtInList')}>
              {visibleWidgets.map((widget) => (
                <button
                  aria-selected={selectedId === widget.id}
                  className={selectedId === widget.id ? 'active' : ''}
                  key={widget.id}
                  onClick={() => setSelectedId(widget.id)}
                  role="option"
                  type="button"
                >
                  <Server size={15} aria-hidden="true" />
                  <span>
                    <strong>{widgetName(widget.id, widget.name, x)}</strong>
                    <small>
                      {x(widget.type === 'instance' ? 'widgets.serverInstance' : 'widgets.runOnce')}
                    </small>
                  </span>
                </button>
              ))}
              {!visibleWidgets.length && <p className="widget-empty">{x('widgets.noMatches')}</p>}
            </div>
          </>
        ) : (
          <WidgetInstanceList
            client={client}
            instances={instances.data ?? []}
            onChanged={() => instances.refetch()}
            onNotice={setNotice}
          />
        )}
      </aside>
      <main className="widget-control">
        {selectedId === 'file-renamer' ? (
          <FileRenamerControl client={client} onNotice={setNotice} />
        ) : selectedId === 'local-ftp-server' ? (
          <LocalFtpServerControl
            client={client}
            onNotice={setNotice}
            onStarted={async (instance) => {
              await instances.refetch();
              setTab('instances');
              setNotice({
                tone: 'success',
                title: x('widgets.ftpServerStarted'),
                description: `${instance.serverInfo?.url ?? ''} · ${instance.serverInfo?.rootName ?? ''}`,
              });
            }}
          />
        ) : selectedId === 'local-ssh-server' ? (
          <LocalSshServerControl
            client={client}
            onNotice={setNotice}
            onStarted={async (instance) => {
              await instances.refetch();
              setTab('instances');
              setNotice({
                tone: 'success',
                title: x('widgets.sshServerStarted'),
                description: `${instance.serverInfo?.url ?? ''} · ${instance.serverInfo?.rootName ?? ''}`,
              });
            }}
          />
        ) : selectedId === 'mcp-server' ? (
          <McpServerControl
            client={client}
            onNotice={setNotice}
            onStarted={async (instance) => {
              await instances.refetch();
              setTab('instances');
              setNotice({
                tone: 'success',
                title: x('widgets.mcpServerStarted'),
                description: instance.serverInfo?.url ?? '',
              });
            }}
          />
        ) : selectedId === 'local-file-server' ? (
          <form className="widget-form" onSubmit={(event) => void startFileServer(event)}>
            <header>
              <span>{x('widgets.builtIn')}</span>
              <h2>{x('widgets.fileServer')}</h2>
              <p>{x('widgets.fileServerDescription')}</p>
            </header>
            <label>
              {x('widgets.instanceName')}
              <input name="title" defaultValue={x('widgets.fileServer')} maxLength={100} required />
            </label>
            <label>
              {x('widgets.directoryGrant')}
              <span className="widget-grant-row">
                <input value={grant?.name ?? ''} placeholder={x('widgets.noDirectory')} readOnly />
                <button type="button" onClick={() => void selectDirectory()}>
                  <FolderOpen size={14} /> {x('widgets.chooseDirectory')}
                </button>
              </span>
            </label>
            <div className="widget-form-grid">
              <label>
                {x('widgets.host')}
                <select name="host" defaultValue="127.0.0.1">
                  <option value="127.0.0.1">127.0.0.1 ({x('widgets.loopback')})</option>
                  <option value="::1">::1 ({x('widgets.ipv6Loopback')})</option>
                  <option value="0.0.0.0">0.0.0.0 ({x('widgets.allInterfaces')})</option>
                  <option value="::">:: ({x('widgets.allIpv6Interfaces')})</option>
                </select>
              </label>
              <label>
                {x('widgets.port')}
                <input name="port" type="number" min={0} max={65_535} defaultValue={3456} />
                <small>{x('widgets.autoPort')}</small>
              </label>
              <label>
                {x('widgets.indexFile')}
                <input name="index" defaultValue="index.html" required />
              </label>
              <label>
                {x('widgets.dotfiles')}
                <select name="dotfiles" defaultValue="allow">
                  <option value="allow">{x('widgets.allow')}</option>
                  <option value="deny">{x('widgets.deny')}</option>
                  <option value="ignore">{x('widgets.ignore')}</option>
                </select>
              </label>
              <label>
                {x('widgets.cacheMaxAge')}
                <input
                  name="maxAgeMs"
                  type="number"
                  min={0}
                  max={31_536_000_000}
                  defaultValue={31_536_000_000}
                />
              </label>
            </div>
            <fieldset className="widget-options">
              <legend>{x('widgets.staticOptions')}</legend>
              {[
                ['cacheControl', 'Cache-Control'],
                ['lastModified', 'Last-Modified'],
                ['etag', 'ETag'],
                ['acceptRanges', x('widgets.acceptRanges')],
                ['redirect', x('widgets.directoryRedirect')],
              ].map(([name, label]) => (
                <label key={name}>
                  <input name={name} type="checkbox" defaultChecked /> {label}
                </label>
              ))}
            </fieldset>
            <p className="widget-scope-note">
              <Check size={14} /> {x('widgets.fileServerBoundary')}
            </p>
            <button className="widget-primary" disabled={starting}>
              <Play size={14} /> {x(starting ? 'widgets.starting' : 'widgets.start')}
            </button>
          </form>
        ) : (
          <div className="widget-control-empty">{x('widgets.selectToConfigure')}</div>
        )}
      </main>
      {notice && (
        <div className={`widget-notice ${notice.tone}`} role="status" aria-live="polite">
          <span>
            <strong>{notice.title}</strong>
            <small>{notice.description}</small>
          </span>
          <button
            aria-label={x('widgets.closeNotice')}
            type="button"
            onClick={() => setNotice(undefined)}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

const mcpTools = [
  { name: 'host.getSummary', label: 'widgets.mcpToolHost', risk: 'read' },
  { name: 'terminal.getRecentOutput', label: 'widgets.mcpToolOutput', risk: 'read' },
  { name: 'terminal.execReadOnly', label: 'widgets.mcpToolDiagnostic', risk: 'read' },
  { name: 'sftp.list', label: 'widgets.mcpToolSftpList', risk: 'read' },
  { name: 'sftp.readText', label: 'widgets.mcpToolSftpRead', risk: 'read' },
  { name: 'system.inspectDisk', label: 'widgets.mcpToolDisk', risk: 'read' },
  { name: 'system.inspectMemory', label: 'widgets.mcpToolMemory', risk: 'read' },
  { name: 'system.inspectProcesses', label: 'widgets.mcpToolProcesses', risk: 'read' },
  { name: 'system.inspectService', label: 'widgets.mcpToolService', risk: 'read' },
  { name: 'terminal.exec', label: 'widgets.mcpToolExec', risk: 'mutating' },
] as const;

function McpServerControl({
  client,
  onStarted,
  onNotice,
}: {
  client: Client;
  onStarted(instance: WidgetInstance): Promise<void>;
  onNotice(notice: Notice): void;
}) {
  const { x } = useI18n();
  const [busy, setBusy] = useState(false);
  const apiKeyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (apiKeyRef.current) apiKeyRef.current.value = generateMcpApiKey();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const enabledTools = form.getAll('enabledTools').map(String) as NonNullable<
      StartMcpServerInput['enabledTools']
    >;
    if (!enabledTools.length) {
      onNotice({
        tone: 'error',
        title: x('widgets.mcpNoTools'),
        description: x('widgets.mcpChooseTool'),
      });
      return;
    }
    const apiKey = stringValue(form, 'apiKey');
    setBusy(true);
    let credentialRef: string | undefined;
    try {
      const credential = await client.createCredential({
        kind: 'mcpApiKey',
        label: `${stringValue(form, 'title')} API key`,
        secret: apiKey,
      });
      credentialRef = credential.ref;
      const instance = await client.startMcpServerWidget({
        title: stringValue(form, 'title'),
        host: stringValue(form, 'host') as '127.0.0.1' | '::1',
        port: numberValue(form, 'port'),
        credentialRef,
        enabledTools,
      });
      credentialRef = undefined;
      if (apiKeyRef.current) apiKeyRef.current.value = '';
      await onStarted(instance);
    } catch (cause) {
      if (credentialRef) await client.deleteCredential(credentialRef).catch(() => undefined);
      onNotice({
        tone: 'error',
        title: x('widgets.mcpStartFailed'),
        description: messageOf(cause, x),
      });
    } finally {
      setBusy(false);
    }
  }

  function generateApiKey() {
    if (!apiKeyRef.current) return;
    apiKeyRef.current.value = generateMcpApiKey();
    apiKeyRef.current.focus();
  }

  async function copyApiKey() {
    if (!apiKeyRef.current?.value) return;
    try {
      await navigator.clipboard.writeText(apiKeyRef.current.value);
      onNotice({
        tone: 'success',
        title: x('widgets.mcpKeyCopied'),
        description: x('widgets.mcpKeyCopyHint'),
      });
    } catch (cause) {
      onNotice({ tone: 'error', title: x('widgets.copyFailed'), description: messageOf(cause, x) });
    }
  }

  return (
    <form className="widget-form mcp-widget-form" onSubmit={(event) => void submit(event)}>
      <header>
        <span>{x('widgets.builtInServer')}</span>
        <h2>{x('widgets.mcpServer')}</h2>
        <p>{x('widgets.mcpDescription')}</p>
      </header>
      <div className="mcp-security-summary">
        <ShieldCheck size={18} aria-hidden="true" />
        <span>
          <strong>{x('widgets.mcpSecureTitle')}</strong>
          <small>{x('widgets.mcpSecureDescription')}</small>
        </span>
      </div>
      <label>
        {x('widgets.instanceName')}
        <input name="title" defaultValue={x('widgets.mcpServer')} maxLength={100} required />
      </label>
      <div className="widget-form-grid">
        <label>
          {x('widgets.host')}
          <select name="host" defaultValue="127.0.0.1">
            <option value="127.0.0.1">127.0.0.1 ({x('widgets.loopback')})</option>
            <option value="::1">::1 ({x('widgets.ipv6Loopback')})</option>
          </select>
          <small>{x('widgets.mcpLoopbackOnly')}</small>
        </label>
        <label>
          {x('widgets.port')}
          <input name="port" type="number" min={0} max={65_535} defaultValue={30_837} />
          <small>{x('widgets.autoPort')}</small>
        </label>
      </div>
      <label className="widget-password-field">
        {x('widgets.mcpApiKey')}
        <span className="mcp-api-key-row">
          <input
            name="apiKey"
            ref={apiKeyRef}
            type="password"
            autoComplete="new-password"
            minLength={16}
            maxLength={1024}
            required
          />
          <button type="button" onClick={generateApiKey}>
            {x('widgets.generate')}
          </button>
          <button type="button" onClick={() => void copyApiKey()} title={x('widgets.copyApiKey')}>
            <Copy size={13} />
          </button>
        </span>
        <small>{x('widgets.mcpKeyStorage')}</small>
      </label>
      <fieldset className="mcp-tool-options">
        <legend>{x('widgets.mcpTools')}</legend>
        <p>{x('widgets.mcpToolsDescription')}</p>
        <div>
          {mcpTools.map((tool) => (
            <label key={tool.name}>
              <input name="enabledTools" type="checkbox" value={tool.name} defaultChecked />
              <span>
                <strong>{x(tool.label)}</strong>
                <code>{tool.name}</code>
              </span>
              <em className={tool.risk}>
                {x(tool.risk === 'read' ? 'widgets.mcpReadOnly' : 'widgets.mcpApproval')}
              </em>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="widget-scope-note">
        <KeyRound size={14} /> {x('widgets.mcpLimits')}
      </p>
      <button className="widget-primary" disabled={busy}>
        <Play size={14} /> {x(busy ? 'widgets.starting' : 'widgets.start')}
      </button>
    </form>
  );
}

function LocalFtpServerControl({
  client,
  onStarted,
  onNotice,
}: {
  client: Client;
  onStarted(instance: WidgetInstance): Promise<void>;
  onNotice(notice: Notice): void;
}) {
  const { x } = useI18n();
  const [grant, setGrant] = useState<FileGrant>();
  const [busy, setBusy] = useState(false);

  async function chooseDirectory() {
    try {
      const selected = await client.createFileGrant('open-directory');
      if (selected) setGrant(selected);
    } catch (cause) {
      onNotice({
        tone: 'error',
        title: x('widgets.chooseDirectoryFailed'),
        description: messageOf(cause, x),
      });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!grant) {
      onNotice({
        tone: 'error',
        title: x('widgets.noDirectory'),
        description: x('widgets.grantDirectoryFirst'),
      });
      return;
    }
    const form = new FormData(formElement);
    setBusy(true);
    try {
      const instance = await client.startLocalFtpServerWidget({
        grantId: grant.grantId,
        title: stringValue(form, 'title'),
        host: stringValue(form, 'host'),
        port: numberValue(form, 'port'),
        anonymous: form.get('anonymous') === 'on',
        username: stringValue(form, 'username'),
        password: stringValue(form, 'password') || undefined,
        passivePortStart: numberValue(form, 'passivePortStart'),
        passivePortEnd: numberValue(form, 'passivePortEnd'),
      });
      formElement.reset();
      await onStarted(instance);
    } catch (cause) {
      onNotice({
        tone: 'error',
        title: x('widgets.ftpStartFailed'),
        description: messageOf(cause, x),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="widget-form local-ftp-widget-form" onSubmit={(event) => void submit(event)}>
      <header>
        <span>{x('widgets.builtInServer')}</span>
        <h2>{x('widgets.ftpServer')}</h2>
        <p>{x('widgets.ftpDescription')}</p>
      </header>
      <ServerDirectoryGrant grant={grant} onSelect={chooseDirectory} />
      <label>
        {x('widgets.instanceName')}
        <input name="title" defaultValue={x('widgets.ftpServer')} maxLength={100} required />
      </label>
      <div className="widget-form-grid">
        <ServerBindFields defaultPort={2121} />
        <label>
          {x('widgets.username')}
          <input name="username" defaultValue="ftpuser" maxLength={255} required />
        </label>
        <label>
          {x('widgets.password')}
          <input name="password" type="password" autoComplete="new-password" maxLength={1024} />
          <small>{x('widgets.memoryOnly')}</small>
        </label>
        <label>
          {x('widgets.passiveStart')}
          <input
            name="passivePortStart"
            type="number"
            min={1024}
            max={65_535}
            defaultValue={50_000}
          />
        </label>
        <label>
          {x('widgets.passiveEnd')}
          <input
            name="passivePortEnd"
            type="number"
            min={1024}
            max={65_535}
            defaultValue={50_031}
          />
        </label>
      </div>
      <fieldset className="widget-options">
        <legend>{x('widgets.authentication')}</legend>
        <label>
          <input name="anonymous" type="checkbox" /> {x('widgets.allowAnonymous')}
        </label>
      </fieldset>
      <p className="widget-scope-note">
        <Check size={14} /> {x('widgets.ftpLimits')}
      </p>
      <button className="widget-primary" disabled={busy}>
        <Play size={14} /> {x(busy ? 'widgets.starting' : 'widgets.start')}
      </button>
    </form>
  );
}

function LocalSshServerControl({
  client,
  onStarted,
  onNotice,
}: {
  client: Client;
  onStarted(instance: WidgetInstance): Promise<void>;
  onNotice(notice: Notice): void;
}) {
  const { x } = useI18n();
  const [grant, setGrant] = useState<FileGrant>();
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function chooseDirectory() {
    try {
      const selected = await client.createFileGrant('open-directory');
      if (selected) setGrant(selected);
    } catch (cause) {
      onNotice({
        tone: 'error',
        title: x('widgets.chooseDirectoryFailed'),
        description: messageOf(cause, x),
      });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!grant) {
      onNotice({
        tone: 'error',
        title: x('widgets.noDirectory'),
        description: x('widgets.grantDirectoryFirst'),
      });
      return;
    }
    const form = new FormData(formElement);
    setBusy(true);
    try {
      const instance = await client.startLocalSshServerWidget({
        grantId: grant.grantId,
        title: stringValue(form, 'title'),
        host: stringValue(form, 'host'),
        port: numberValue(form, 'port'),
        username: stringValue(form, 'username'),
        password: stringValue(form, 'password'),
      });
      formElement.reset();
      await onStarted(instance);
    } catch (cause) {
      onNotice({
        tone: 'error',
        title: x('widgets.sshStartFailed'),
        description: messageOf(cause, x),
      });
    } finally {
      setBusy(false);
    }
  }

  function generatePassword() {
    if (!passwordRef.current) return;
    passwordRef.current.value = `ett_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    passwordRef.current.focus();
  }

  return (
    <form className="widget-form local-ssh-widget-form" onSubmit={(event) => void submit(event)}>
      <header>
        <span>{x('widgets.builtInServer')}</span>
        <h2>{x('widgets.sshServer')}</h2>
        <p>{x('widgets.sshDescription')}</p>
      </header>
      <ServerDirectoryGrant grant={grant} onSelect={chooseDirectory} />
      <label>
        {x('widgets.instanceName')}
        <input name="title" defaultValue={x('widgets.sshServer')} maxLength={100} required />
      </label>
      <div className="widget-form-grid">
        <ServerBindFields defaultPort={22_225} />
        <label>
          {x('widgets.username')}
          <input name="username" defaultValue="test" maxLength={255} required />
        </label>
        <label className="widget-password-field">
          {x('widgets.password')}
          <span>
            <input
              name="password"
              ref={passwordRef}
              type="password"
              autoComplete="new-password"
              maxLength={1024}
              required
            />
            <button type="button" onClick={generatePassword}>
              {x('widgets.generate')}
            </button>
          </span>
          <small>{x('widgets.memoryNoStorage')}</small>
        </label>
      </div>
      <p className="widget-scope-note">
        <Check size={14} /> {x('widgets.sshLimits')}
      </p>
      <button className="widget-primary" disabled={busy}>
        <Play size={14} /> {x(busy ? 'widgets.starting' : 'widgets.start')}
      </button>
    </form>
  );
}

function ServerDirectoryGrant({
  grant,
  onSelect,
}: {
  grant: FileGrant | undefined;
  onSelect(): Promise<void>;
}) {
  const { x } = useI18n();
  return (
    <label>
      {x('widgets.directoryGrant')}
      <span className="widget-grant-row">
        <input value={grant?.name ?? ''} placeholder={x('widgets.noDirectory')} readOnly />
        <button type="button" onClick={() => void onSelect()}>
          <FolderOpen size={14} /> {x('widgets.chooseDirectory')}
        </button>
      </span>
    </label>
  );
}

function ServerBindFields({ defaultPort }: { defaultPort: number }) {
  const { x } = useI18n();
  return (
    <>
      <label>
        {x('widgets.host')}
        <select name="host" defaultValue="127.0.0.1">
          <option value="127.0.0.1">127.0.0.1 ({x('widgets.loopback')})</option>
          <option value="::1">::1 ({x('widgets.ipv6Loopback')})</option>
          <option value="0.0.0.0">0.0.0.0 ({x('widgets.allInterfaces')})</option>
          <option value="::">:: ({x('widgets.allIpv6Interfaces')})</option>
        </select>
      </label>
      <label>
        {x('widgets.port')}
        <input name="port" type="number" min={0} max={65_535} defaultValue={defaultPort} />
        <small>{x('widgets.autoPort')}</small>
      </label>
    </>
  );
}

function FileRenamerControl({
  client,
  onNotice,
}: {
  client: Client;
  onNotice(notice: Notice): void;
}) {
  const { x } = useI18n();
  const [grant, setGrant] = useState<FileGrant>();
  const [preview, setPreview] = useState<FileRenamePreview>();
  const [busy, setBusy] = useState(false);

  async function selectDirectory() {
    try {
      const selected = await client.createFileGrant('open-directory');
      if (selected) {
        setGrant(selected);
        setPreview(undefined);
      }
    } catch (cause) {
      onNotice({
        tone: 'error',
        title: x('widgets.chooseDirectoryFailed'),
        description: messageOf(cause, x),
      });
    }
  }

  async function createPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!grant) {
      onNotice({
        tone: 'error',
        title: x('widgets.noDirectory'),
        description: x('widgets.grantDirectoryFirst'),
      });
      return;
    }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const result = await client.previewFileRenameWidget({
        grantId: grant.grantId,
        template: stringValue(form, 'template'),
        includeSubfolders: form.get('includeSubfolders') === 'on',
        fileTypes: stringValue(form, 'fileTypes'),
        startNumber: numberValue(form, 'startNumber'),
        preserveCase: form.get('preserveCase') === 'on',
      });
      setPreview(result);
      onNotice({
        tone: result.conflicts ? 'error' : 'success',
        title: x(result.conflicts ? 'widgets.previewConflicts' : 'widgets.previewReady'),
        description: x('widgets.previewCounts', {
          ready: result.ready,
          conflicts: result.conflicts,
        }),
      });
    } catch (cause) {
      onNotice({
        tone: 'error',
        title: x('widgets.previewFailed'),
        description: messageOf(cause, x),
      });
    } finally {
      setBusy(false);
    }
  }

  async function runRename() {
    if (!preview?.canRun) return;
    setBusy(true);
    try {
      const result = await client.runFileRenameWidget(preview.id);
      setPreview(undefined);
      onNotice({
        tone: 'success',
        title: x('widgets.renamerComplete'),
        description: x('widgets.renamedCount', { count: result.renamed }),
      });
    } catch (cause) {
      onNotice({
        tone: 'error',
        title: x('widgets.renameFailed'),
        description: messageOf(cause, x),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="widget-form file-renamer-form"
      onChange={() => setPreview(undefined)}
      onSubmit={(event) => void createPreview(event)}
    >
      <header>
        <span>{x('widgets.builtInRunOnce')}</span>
        <h2>{x('widgets.fileRenamer')}</h2>
        <p>{x('widgets.renamerDescription')}</p>
      </header>
      <label>
        {x('widgets.directoryGrant')}
        <span className="widget-grant-row">
          <input value={grant?.name ?? ''} placeholder={x('widgets.noDirectory')} readOnly />
          <button type="button" onClick={() => void selectDirectory()}>
            <FolderOpen size={14} /> {x('widgets.chooseDirectory')}
          </button>
        </span>
      </label>
      <label>
        {x('widgets.template')}
        <input name="template" defaultValue="{name}-{n}.{ext}" required maxLength={255} />
        <small>{'{n} {n:3} {name} {ext} {date} {time} {random} {parent}'}</small>
      </label>
      <div className="widget-form-grid">
        <label>
          {x('widgets.fileTypes')}
          <input
            name="fileTypes"
            defaultValue="*"
            placeholder={x('widgets.fileTypesPlaceholder')}
            required
          />
        </label>
        <label>
          {x('widgets.startNumber')}
          <input name="startNumber" type="number" min={0} max={1_000_000} defaultValue={1} />
        </label>
      </div>
      <fieldset className="widget-options">
        <legend>{x('widgets.renameOptions')}</legend>
        <label>
          <input name="includeSubfolders" type="checkbox" /> {x('widgets.includeSubfolders')}
        </label>
        <label>
          <input name="preserveCase" type="checkbox" defaultChecked /> {x('widgets.preserveCase')}
        </label>
      </fieldset>
      <p className="widget-scope-note">
        <Check size={14} /> {x('widgets.renamerLimits')}
      </p>
      <button className="widget-primary" disabled={busy}>
        {x(busy ? 'widgets.preparing' : 'widgets.previewRename')}
      </button>
      {preview && (
        <section className="file-rename-preview" aria-label={x('widgets.renamePreview')}>
          <header>
            <strong>{preview.rootName}</strong>
            <span>
              {x('widgets.previewSummary', {
                ready: preview.ready,
                conflicts: preview.conflicts,
                total: preview.total,
              })}
            </span>
          </header>
          <div className="file-rename-preview-list">
            {preview.items.map((item) => (
              <div className={item.state} key={`${item.source}:${item.target}`}>
                <code>{item.source}</code>
                <span>→</span>
                <code>{item.target}</code>
                <em>{item.state}</em>
              </div>
            ))}
          </div>
          <footer>
            <small>{x('widgets.renameSafety')}</small>
            <button
              className="widget-primary"
              disabled={!preview.canRun || busy}
              type="button"
              onClick={() => void runRename()}
            >
              {x('widgets.confirmRename', { count: preview.ready })}
            </button>
          </footer>
        </section>
      )}
    </form>
  );
}

function WidgetInstanceList({
  client,
  instances,
  onChanged,
  onNotice,
}: {
  client: Client;
  instances: WidgetInstance[];
  onChanged(): Promise<unknown>;
  onNotice(notice: Notice): void;
}) {
  const { x } = useI18n();
  const [editing, setEditing] = useState<string>();
  const [confirming, setConfirming] = useState<string>();

  async function copyUrl(instance: WidgetInstance) {
    if (!instance.serverInfo) return;
    try {
      await navigator.clipboard.writeText(instance.serverInfo.url);
      onNotice({
        tone: 'success',
        title: x('widgets.urlCopied'),
        description: instance.serverInfo.url,
      });
    } catch (cause) {
      onNotice({ tone: 'error', title: x('widgets.copyFailed'), description: messageOf(cause, x) });
    }
  }

  async function rename(instance: WidgetInstance, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = stringValue(new FormData(event.currentTarget), 'title');
    try {
      await client.renameWidgetInstance(instance.id, { title });
      setEditing(undefined);
      await onChanged();
      onNotice({ tone: 'success', title: x('widgets.instanceRenamed'), description: title });
    } catch (cause) {
      onNotice({
        tone: 'error',
        title: x('widgets.renameFailed'),
        description: messageOf(cause, x),
      });
    }
  }

  async function stop(instance: WidgetInstance) {
    try {
      const stopped = await client.stopWidgetInstance(instance.id);
      setConfirming(undefined);
      await onChanged();
      onNotice({
        tone: 'success',
        title: x('widgets.stopped'),
        description: `${stopped.title} · ${stopped.serverInfo?.url ?? ''}`,
      });
    } catch (cause) {
      onNotice({ tone: 'error', title: x('widgets.stopFailed'), description: messageOf(cause, x) });
    }
  }

  if (!instances.length)
    return (
      <div className="widget-empty-instances">
        <Square size={18} />
        <strong>{x('widgets.noRunning')}</strong>
        <small>{x('widgets.runningHint')}</small>
      </div>
    );
  return (
    <div className="widget-instance-list">
      {instances.map((instance) => (
        <article key={instance.id}>
          {editing === instance.id ? (
            <form onSubmit={(event) => void rename(instance, event)}>
              <input
                name="title"
                defaultValue={instance.title}
                autoFocus
                required
                maxLength={100}
              />
              <button aria-label={x('widgets.saveName')} title={x('widgets.saveName')}>
                <Check size={13} />
              </button>
            </form>
          ) : (
            <button
              className="widget-instance-title"
              type="button"
              title={`${instance.serverInfo?.url ?? ''}\n${instance.serverInfo?.rootName ?? ''}`}
              onClick={() => setEditing(instance.id)}
            >
              <i className={instance.state} />
              <span>
                <strong>{instance.title}</strong>
                <small>
                  {instance.serverInfo?.url}
                  {instance.serverInfo?.username ? ` · ${instance.serverInfo.username}` : ''}
                  {instance.widgetId === 'mcp-server' && instance.serverInfo
                    ? ` · ${x('widgets.mcpInstanceStatus', {
                        tools: instance.serverInfo.toolCount ?? 0,
                        sessions: instance.serverInfo.activeSessions ?? 0,
                      })}`
                    : ''}
                </small>
              </span>
            </button>
          )}
          <div className="widget-instance-actions">
            <button
              type="button"
              title={x('widgets.copyUrl')}
              onClick={() => void copyUrl(instance)}
            >
              <Copy size={13} />
            </button>
            {instance.widgetId !== 'mcp-server' && (
              <button
                type="button"
                title={x('widgets.openBrowser')}
                onClick={() =>
                  instance.serverInfo && void client.openExternal(instance.serverInfo.url)
                }
              >
                <ExternalLink size={13} />
              </button>
            )}
            <button
              type="button"
              title={x('widgets.rename')}
              onClick={() => setEditing(instance.id)}
            >
              <Pencil size={13} />
            </button>
            <button
              className={confirming === instance.id ? 'confirm-stop' : ''}
              type="button"
              title={x(confirming === instance.id ? 'widgets.confirmStop' : 'widgets.stop')}
              onClick={() =>
                confirming === instance.id ? void stop(instance) : setConfirming(instance.id)
              }
            >
              <Square size={12} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function stringValue(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

function numberValue(form: FormData, name: string): number {
  return Number(form.get(name));
}

function messageOf(cause: unknown, x: ReturnType<typeof useI18n>['x']): string {
  return cause instanceof Error ? cause.message : x('widgets.unknownError');
}

function widgetName(id: string, fallback: string, x: ReturnType<typeof useI18n>['x']): string {
  const keys = {
    'local-file-server': 'widgets.fileServer',
    'local-ftp-server': 'widgets.ftpServer',
    'local-ssh-server': 'widgets.sshServer',
    'file-renamer': 'widgets.fileRenamer',
    'mcp-server': 'widgets.mcpServer',
  } as const;
  return id in keys ? x(keys[id as keyof typeof keys]) : fallback;
}

function widgetDescription(
  id: string,
  fallback: string,
  x: ReturnType<typeof useI18n>['x'],
): string {
  const keys = {
    'local-file-server': 'widgets.fileServerDescription',
    'local-ftp-server': 'widgets.ftpDescription',
    'local-ssh-server': 'widgets.sshDescription',
    'file-renamer': 'widgets.renamerDescription',
    'mcp-server': 'widgets.mcpDescription',
  } as const;
  return id in keys ? x(keys[id as keyof typeof keys]) : fallback;
}

function generateMcpApiKey(): string {
  return `axo_mcp_${crypto.randomUUID().replaceAll('-', '')}`;
}
