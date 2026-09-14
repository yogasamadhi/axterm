import { randomUUID } from 'node:crypto';
import type {
  CreateWebSessionInput,
  WebSession,
  WebSessionAction,
  WebSessionAuthResponse,
  WebSessionPresentation,
} from '@workspace/contracts';
import type { HostWebViewState } from '@workspace/contracts/desktop';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { BookmarkTreeService } from './bookmark-tree-service';
import { ApplicationError } from './errors';

interface ManagedWebSession {
  id: string;
  bookmarkId: string;
  title: string;
  description: string;
  url: string;
  userAgent: string | null;
  hideAddressBar: boolean;
  createdAt: string;
  updatedAt: string;
  hostState: HostWebViewState;
}

export class WebSessionService {
  private readonly sessions = new Map<string, ManagedWebSession>();

  constructor(
    private readonly bookmarks: BookmarkTreeService,
    private readonly host: HostCapabilityClient | undefined,
  ) {}

  async create(input: CreateWebSessionInput): Promise<WebSession> {
    const bookmark = this.bookmarks.getBookmark(input.bookmarkId);
    if (bookmark.protocol !== 'web' || !bookmark.web)
      throw new ApplicationError('VALIDATION_ERROR', 'Bookmark is not a Web destination', 400);
    if (this.sessions.size >= 8)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The active Web Session limit has been reached',
        503,
      );
    const id = randomUUID();
    const now = new Date().toISOString();
    const hostState = await this.requireHost().createWebView({
      id,
      url: bookmark.web.url,
      userAgent: bookmark.web.userAgent,
    });
    const managed: ManagedWebSession = {
      id,
      bookmarkId: bookmark.id,
      title: bookmark.title,
      description: bookmark.description,
      url: bookmark.web.url,
      userAgent: bookmark.web.userAgent,
      hideAddressBar: bookmark.web.hideAddressBar,
      createdAt: now,
      updatedAt: now,
      hostState,
    };
    this.sessions.set(id, managed);
    return toSession(managed);
  }

  async list(): Promise<WebSession[]> {
    return Promise.all([...this.sessions.keys()].map((id) => this.get(id)));
  }

  async get(id: string): Promise<WebSession> {
    const managed = this.require(id);
    try {
      managed.hostState = await this.requireHost().webView(id);
    } catch (error) {
      managed.hostState = {
        ...managed.hostState,
        state: 'failed',
        visible: false,
        loading: false,
        errorCode: 'WEB_VIEW_UNAVAILABLE',
      };
      if (!(error instanceof ApplicationError)) throw error;
    }
    managed.updatedAt = new Date().toISOString();
    return toSession(managed);
  }

  async present(id: string, input: WebSessionPresentation): Promise<WebSession> {
    const managed = this.require(id);
    managed.hostState = await this.requireHost().presentWebView(id, input);
    managed.updatedAt = new Date().toISOString();
    return toSession(managed);
  }

  async perform(id: string, input: WebSessionAction): Promise<WebSession> {
    const managed = this.require(id);
    managed.hostState = await this.requireHost().performWebViewAction(id, input);
    managed.updatedAt = new Date().toISOString();
    return toSession(managed);
  }

  async authenticate(id: string, input: WebSessionAuthResponse): Promise<WebSession> {
    const managed = this.require(id);
    managed.hostState = await this.requireHost().authenticateWebView(id, input);
    managed.updatedAt = new Date().toISOString();
    return toSession(managed);
  }

  async close(id: string): Promise<void> {
    if (!this.sessions.delete(id)) return;
    await this.host?.closeWebView(id).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  resourceCount(): number {
    return this.sessions.size;
  }

  private require(id: string): ManagedWebSession {
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Web Session not found', 404);
    return managed;
  }

  private requireHost() {
    if (!this.host)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Desktop Web Session capability is unavailable',
        503,
      );
    return this.host;
  }
}

function toSession(managed: ManagedWebSession): WebSession {
  return {
    id: managed.id,
    bookmarkId: managed.bookmarkId,
    title: managed.title,
    description: managed.description,
    state: managed.hostState.state,
    url: managed.url,
    currentUrl: managed.hostState.url,
    userAgent: managed.userAgent,
    hideAddressBar: managed.hideAddressBar,
    loading: managed.hostState.loading,
    canGoBack: managed.hostState.canGoBack,
    canGoForward: managed.hostState.canGoForward,
    zoomFactor: managed.hostState.zoomFactor,
    visible: managed.hostState.visible,
    ...(managed.hostState.blockedUrl ? { blockedUrl: managed.hostState.blockedUrl } : {}),
    ...(managed.hostState.errorCode ? { errorCode: managed.hostState.errorCode } : {}),
    ...(managed.hostState.authChallenge ? { authChallenge: managed.hostState.authChallenge } : {}),
    createdAt: managed.createdAt,
    updatedAt: managed.updatedAt,
  };
}
