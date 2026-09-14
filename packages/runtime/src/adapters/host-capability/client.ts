import {
  desktopWindowActionResultSchema,
  desktopLifecycleStateSchema,
  desktopWindowPreferencesPatchSchema,
  desktopWindowPreferencesResultSchema,
  desktopWindowStateSchema,
  fileGrantSchema,
  grantedDirectoryListRequestSchema,
  grantedDirectoryListingSchema,
  grantedEntriesOperationRequestSchema,
  grantedEntryCreateRequestSchema,
  grantedEntryChmodRequestSchema,
  grantedEntryPathRequestSchema,
  grantedEntryPathsRequestSchema,
  grantedEntryRenameRequestSchema,
  grantedTransferPathRequestSchema,
  grantedTextSchema,
  hostCredentialMetadataSchema,
  hostCredentialResolveSchema,
  localDirectoryGrantRequestSchema,
  hostWebViewActionSchema,
  hostWebViewAuthResponseSchema,
  hostWebViewCreateSchema,
  hostWebViewPresentationSchema,
  hostWebViewStateSchema,
  resolvedGrantSchema,
  updaterStatusSchema,
  updaterActionSchema,
  type FileGrant,
  type HostCredentialMetadata,
  type DesktopWindowAction,
  type DesktopWindowPreferencesPatch,
  type HostWebViewAction,
  type HostWebViewAuthResponse,
  type HostWebViewCreate,
  type HostWebViewPresentation,
  type UpdaterAction,
} from '@workspace/contracts/desktop';
import { ApplicationError } from '../../application/errors';
import { open } from 'node:fs/promises';

const MAX_GRANTED_TEXT_BYTES = 2 * 1024 * 1024;

export class HostCapabilityClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  listCredentials(): Promise<HostCredentialMetadata[]> {
    return this.request('/host/v1/credentials', { method: 'GET' }).then((value) =>
      hostCredentialMetadataSchema.array().parse(value),
    );
  }
  createCredential(input: { kind: string; label: string; secret: string }) {
    return this.request('/host/v1/credentials', { method: 'POST', body: input }).then((value) =>
      hostCredentialMetadataSchema.parse(value),
    );
  }
  replaceCredential(ref: string, secret: string) {
    return this.request(`/host/v1/credentials/${encodeURIComponent(ref)}`, {
      method: 'PATCH',
      body: { secret },
    }).then((value) => hostCredentialMetadataSchema.parse(value));
  }
  async deleteCredential(ref: string) {
    await this.request(`/host/v1/credentials/${encodeURIComponent(ref)}`, { method: 'DELETE' });
  }
  resolveCredential(ref: string) {
    return this.request(`/host/v1/credentials/${encodeURIComponent(ref)}/resolve`, {
      method: 'POST',
      body: {},
    }).then((value) => hostCredentialResolveSchema.parse(value).secret);
  }
  openDialog(kind: 'open-file' | 'open-directory' | 'save-file'): Promise<FileGrant | undefined> {
    return this.request(`/host/v1/dialogs/${kind}`, { method: 'POST', body: {} }).then((value) =>
      value === undefined ? undefined : fileGrantSchema.parse(value),
    );
  }
  openLocalDirectory(path?: string): Promise<FileGrant> {
    return this.request('/host/v1/grants/directory', {
      method: 'POST',
      body: localDirectoryGrantRequestSchema.parse(path ? { path } : {}),
    }).then((value) => fileGrantSchema.parse(value));
  }
  async importDroppedFile(
    name: string,
    size: number,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<FileGrant> {
    const response = await fetch(`${this.baseUrl}/host/v1/grants/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
        'X-Axterm-File-Name': encodeURIComponent(name),
        'X-Axterm-File-Size': String(size),
      },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!response.ok)
      throw new ApplicationError(
        response.status === 400 ? 'VALIDATION_ERROR' : 'CAPABILITY_UNAVAILABLE',
        response.status === 400
          ? 'The dropped file was rejected'
          : 'Desktop file capability is unavailable',
        response.status === 400 ? 400 : 503,
      );
    return fileGrantSchema.parse(await response.json());
  }
  async createEditableFile(
    name: string,
    content: string,
    signal: AbortSignal = AbortSignal.timeout(10_000),
  ): Promise<FileGrant> {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > MAX_GRANTED_TEXT_BYTES)
      throw new ApplicationError(
        'PAYLOAD_TOO_LARGE',
        `The editable text file must not exceed ${MAX_GRANTED_TEXT_BYTES} bytes`,
        413,
      );
    const response = await fetch(`${this.baseUrl}/host/v1/grants/editable`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
        'X-Axterm-File-Name': encodeURIComponent(name),
        'X-Axterm-File-Size': String(bytes.length),
      },
      body: bytes,
      signal,
    });
    if (!response.ok)
      throw new ApplicationError(
        response.status === 400 ? 'VALIDATION_ERROR' : 'CAPABILITY_UNAVAILABLE',
        response.status === 400
          ? 'The editable file was rejected'
          : 'Desktop editor capability is unavailable',
        response.status === 400 ? 400 : 503,
      );
    return fileGrantSchema.parse(await response.json());
  }
  resolveGrant(grantId: string) {
    return this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/resolve`, {
      method: 'POST',
      body: {},
    }) as Promise<FileGrant & { path: string }>;
  }
  resolveGrantTransferPath(grantId: string, path: string, intent: 'read' | 'write-target') {
    return this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/transfer-path`, {
      method: 'POST',
      body: grantedTransferPathRequestSchema.parse({ path, intent }),
    }).then((value) => resolvedGrantSchema.parse(value));
  }
  async readGrantedText(grantId: string) {
    const grant = await this.resolveGrant(grantId);
    if (grant.kind !== 'file' || !grant.permissions.includes('read'))
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'The selected grant does not allow reading a file',
        400,
      );
    const handle = await open(grant.path, 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_GRANTED_TEXT_BYTES)
        throw new ApplicationError(
          'PAYLOAD_TOO_LARGE',
          `The selected text file must not exceed ${MAX_GRANTED_TEXT_BYTES} bytes`,
          413,
        );
      const buffer = Buffer.alloc(MAX_GRANTED_TEXT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      if (bytesRead > MAX_GRANTED_TEXT_BYTES)
        throw new ApplicationError(
          'PAYLOAD_TOO_LARGE',
          `The selected text file must not exceed ${MAX_GRANTED_TEXT_BYTES} bytes`,
          413,
        );
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } catch {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'The selected file must contain UTF-8 text',
          400,
        );
      }
      return grantedTextSchema.parse({ name: grant.name, content });
    } finally {
      await handle.close();
    }
  }
  async readGrantedTextPrefix(
    grantId: string,
    maxBytes: number,
    maxSourceBytes: number,
    signal?: AbortSignal,
  ) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_GRANTED_TEXT_BYTES)
      throw new ApplicationError('VALIDATION_ERROR', 'The text prefix limit is invalid', 400);
    if (
      !Number.isInteger(maxSourceBytes) ||
      maxSourceBytes < maxBytes ||
      maxSourceBytes > MAX_GRANTED_TEXT_BYTES
    )
      throw new ApplicationError('VALIDATION_ERROR', 'The source file limit is invalid', 400);
    if (signal?.aborted)
      throw new ApplicationError('REQUEST_CANCELED', 'The file read was canceled', 409);
    const grant = await this.resolveGrant(grantId);
    if (grant.kind !== 'file' || !grant.permissions.includes('read'))
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'The selected grant does not allow reading a file',
        400,
      );
    const handle = await open(grant.path, 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > maxSourceBytes)
        throw new ApplicationError(
          'PAYLOAD_TOO_LARGE',
          `The selected text file must not exceed ${maxSourceBytes} bytes`,
          413,
        );
      const bytesToRead = Math.min(metadata.size, maxBytes);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      if (signal?.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'The file read was canceled', 409);
      const bytes = buffer.subarray(0, bytesRead);
      if (!looksLikeText(bytes))
        throw new ApplicationError('VALIDATION_ERROR', 'The selected file must contain text', 400);
      const decoded = decodeUtf8Prefix(bytes, metadata.size > bytesRead);
      return {
        name: grant.name,
        size: metadata.size,
        content: decoded.content,
        includedBytes: decoded.includedBytes,
        truncated: metadata.size > decoded.includedBytes,
      };
    } finally {
      await handle.close();
    }
  }
  async revokeGrant(grantId: string) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
  }
  listGrantedDirectory(grantId: string, path: string) {
    return this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/list`, {
      method: 'POST',
      body: grantedDirectoryListRequestSchema.parse({ path }),
    }).then((value) => grantedDirectoryListingSchema.parse(value));
  }
  async createGrantedEntry(
    grantId: string,
    input: { path: string; name: string; type: 'file' | 'directory' },
  ) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/entries`, {
      method: 'POST',
      body: grantedEntryCreateRequestSchema.parse(input),
    });
  }
  async renameGrantedEntry(grantId: string, input: { path: string; name: string }) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/rename`, {
      method: 'POST',
      body: grantedEntryRenameRequestSchema.parse(input),
    });
  }
  async chmodGrantedEntry(grantId: string, path: string, mode: number) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/chmod`, {
      method: 'POST',
      body: grantedEntryChmodRequestSchema.parse({ path, mode }),
    });
  }
  async deleteGrantedEntry(grantId: string, path: string) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/delete`, {
      method: 'POST',
      body: grantedEntryPathRequestSchema.parse({ path }),
    });
  }
  async openGrantedEntry(grantId: string, path: string) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/open`, {
      method: 'POST',
      body: grantedEntryPathRequestSchema.parse({ path }),
    });
  }
  async revealGrantedEntry(grantId: string, path: string) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/reveal`, {
      method: 'POST',
      body: grantedEntryPathRequestSchema.parse({ path }),
    });
  }
  async openEditableFile(grantId: string, editorExecutable?: string) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/open-self`, {
      method: 'POST',
      body: editorExecutable ? { editorExecutable } : {},
    });
  }
  async copyGrantedEntryPaths(grantId: string, paths: string[]) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/copy-path`, {
      method: 'POST',
      body: grantedEntryPathsRequestSchema.parse({ paths }),
    });
  }
  async operateGrantedEntries(
    grantId: string,
    input: {
      paths: string[];
      destination: string;
      operation: 'copy' | 'move';
      conflict: 'skip' | 'overwrite' | 'rename';
    },
  ) {
    await this.request(`/host/v1/grants/${encodeURIComponent(grantId)}/operate`, {
      method: 'POST',
      body: grantedEntriesOperationRequestSchema.parse(input),
    });
  }
  updaterStatus() {
    return this.request('/host/v1/updater/status', { method: 'GET' }).then((value) =>
      updaterStatusSchema.parse(value),
    );
  }
  updaterAction(action: UpdaterAction) {
    return this.request('/host/v1/updater/actions', {
      method: 'POST',
      body: updaterActionSchema.parse({ action }),
    }).then((value) => updaterStatusSchema.parse(value));
  }
  lifecycle(signal?: AbortSignal) {
    return this.request('/host/v1/desktop/lifecycle', {
      method: 'GET',
      ...(signal ? { signal } : {}),
    }).then((value) => desktopLifecycleStateSchema.parse(value));
  }
  async openExternal(url: string) {
    await this.request('/host/v1/external-url/open', { method: 'POST', body: { url } });
  }
  async notify(title: string, body: string) {
    await this.request('/host/v1/notifications', { method: 'POST', body: { title, body } });
  }
  windowStatus() {
    return this.request('/host/v1/desktop/window', { method: 'GET' }).then((value) =>
      desktopWindowStateSchema.parse(value),
    );
  }
  performWindowAction(action: DesktopWindowAction) {
    return this.request('/host/v1/desktop/window/actions', {
      method: 'POST',
      body: { action },
    }).then((value) => desktopWindowActionResultSchema.parse(value));
  }
  windowPreferences() {
    return this.request('/host/v1/desktop/window/preferences', { method: 'GET' }).then((value) =>
      desktopWindowPreferencesResultSchema.parse(value),
    );
  }
  updateWindowPreferences(input: DesktopWindowPreferencesPatch) {
    const body = desktopWindowPreferencesPatchSchema.parse(input);
    return this.request('/host/v1/desktop/window/preferences', {
      method: 'PATCH',
      body,
    }).then((value) => desktopWindowPreferencesResultSchema.parse(value));
  }
  createWebView(input: HostWebViewCreate) {
    return this.request('/host/v1/web-views', {
      method: 'POST',
      body: hostWebViewCreateSchema.parse(input),
    }).then((value) => hostWebViewStateSchema.parse(value));
  }
  webView(id: string) {
    return this.request(`/host/v1/web-views/${encodeURIComponent(id)}`, { method: 'GET' }).then(
      (value) => hostWebViewStateSchema.parse(value),
    );
  }
  presentWebView(id: string, input: HostWebViewPresentation) {
    return this.request(`/host/v1/web-views/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: hostWebViewPresentationSchema.parse(input),
    }).then((value) => hostWebViewStateSchema.parse(value));
  }
  performWebViewAction(id: string, input: HostWebViewAction) {
    return this.request(`/host/v1/web-views/${encodeURIComponent(id)}/actions`, {
      method: 'POST',
      body: hostWebViewActionSchema.parse(input),
    }).then((value) => hostWebViewStateSchema.parse(value));
  }
  authenticateWebView(id: string, input: HostWebViewAuthResponse) {
    return this.request(`/host/v1/web-views/${encodeURIComponent(id)}/auth`, {
      method: 'POST',
      body: hostWebViewAuthResponseSchema.parse(input),
    }).then((value) => hostWebViewStateSchema.parse(value));
  }
  async closeWebView(id: string) {
    await this.request(`/host/v1/web-views/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  private async request(
    path: string,
    input: { method: string; body?: unknown; signal?: AbortSignal },
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
    if (response.status === 204) return undefined;
    if (!response.ok) {
      const status = response.status;
      const code = await response
        .json()
        .then((value: unknown) =>
          value && typeof value === 'object' && 'code' in value ? String(value.code) : '',
        )
        .catch(() => '');
      if (status === 400)
        throw new ApplicationError('VALIDATION_ERROR', code || 'Invalid desktop operation', 400);
      if (status === 404)
        throw new ApplicationError('NOT_FOUND', code || 'Desktop resource was not found', 404);
      if (status === 409)
        throw new ApplicationError('CONFLICT', code || 'Desktop operation conflicted', 409);
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        code || 'Desktop capability is unavailable',
        503,
      );
    }
    return response.json();
  }
}

function looksLikeText(buffer: Uint8Array): boolean {
  const length = Math.min(buffer.byteLength, 8 * 1024);
  if (!length) return false;
  let control = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index]!;
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / length <= 0.1;
}

function decodeUtf8Prefix(
  buffer: Uint8Array,
  allowTrailingPartialCodePoint: boolean,
): { content: string; includedBytes: number } {
  const minimum = allowTrailingPartialCodePoint
    ? Math.max(0, buffer.byteLength - 3)
    : buffer.byteLength;
  for (let length = buffer.byteLength; length >= minimum; length -= 1) {
    try {
      return {
        content: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)),
        includedBytes: length,
      };
    } catch {
      // A valid UTF-8 code point may cross the bounded prefix by at most three bytes.
    }
  }
  throw new ApplicationError('VALIDATION_ERROR', 'The selected file must contain UTF-8 text', 400);
}
