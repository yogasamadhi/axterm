import { randomUUID } from 'node:crypto';
import { open, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  commitSshConfigImportSchema,
  DEFAULT_HOST_PROXY,
  DEFAULT_SSH_CONNECTION_OPTIONS,
  importHostsSchema,
  previewSshConfigImportSchema,
  sshConfigImportDraftSchema,
  type CommitSshConfigImportInput,
  type Host,
  type ImportHostsInput,
  type PreviewSshConfigImportInput,
  type SshConfigImportDraft,
  type SshConfigImportPreview,
  type SshConfigImportPreviewItem,
  type SshConfigIncludeRequest,
  type SshConfigImportItem,
  type SshConfigImportNotice,
  type SshConfigImportResult,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { BookmarkTreeService } from './bookmark-tree-service';
import { ApplicationError } from './errors';

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_HOST_BLOCKS = 2_000;
const MAX_IMPORTED_HOSTS = 1_000;
const MAX_PROXY_HOPS = 8;
const MAX_ITEM_NOTICES = 64;
const MAX_INCLUDE_DEPTH = 4;
const MAX_INCLUDE_FILES = 64;
const MAX_INCLUDE_REQUESTS = 128;
const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_PREVIEWS = 8;

interface SourceLine {
  text: string;
  line: number;
  sourceName: string;
}

interface AnalyzedHost {
  id: string;
  index: number;
  line: number;
  sourceName: string;
  name: string;
  title: string;
  description: string;
  hostname: string;
  username: string;
  port: number;
  authType: Host['authType'];
  proxy: Host['proxy'];
  proxyJumps: string[];
  connectionOptions: Host['connectionOptions'];
  notices: SshConfigImportNotice[];
}

interface ParsedSshConfig {
  hosts: AnalyzedHost[];
  skipped: SshConfigImportItem[];
  notices: SshConfigImportNotice[];
  sourceNames: Map<number, string>;
}

interface RawHostBlock {
  id: string;
  index: number;
  line: number;
  sourceName: string;
  expression: string;
  fields: Map<string, { value: string; line: number }>;
  unsupported: Array<{ name: string; line: number }>;
}

interface PlannedHost {
  parsed: AnalyzedHost;
  existing?: Host;
  desiredJumpAlias: string | null;
}

interface CachedPreview {
  expiresAt: number;
  parsed: ParsedSshConfig;
}

interface ExpandedConfig {
  lines: SourceLine[];
  includes: SshConfigIncludeRequest[];
  notices: SshConfigImportNotice[];
  sourceName: string;
}

interface ReadBudget {
  bytes: number;
  files: number;
}

type ResolvedGrant = Awaited<ReturnType<HostCapabilityClient['resolveGrant']>>;

interface ExpansionState {
  host: Pick<HostCapabilityClient, 'resolveGrant'>;
  bindings: Map<string, string>;
  usedBindings: Set<string>;
  includes: SshConfigIncludeRequest[];
  notices: SshConfigImportNotice[];
  lines: SourceLine[];
  budget: ReadBudget;
}

export class HostImportService {
  private readonly previews = new Map<string, CachedPreview>();

  constructor(
    private readonly host: Pick<HostCapabilityClient, 'resolveGrant'> | undefined,
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: ProductRepository,
    private readonly bookmarks: BookmarkTreeService,
  ) {}

  async preview(input: PreviewSshConfigImportInput): Promise<SshConfigImportPreview> {
    const command = previewSshConfigImportSchema.parse(input);
    const expanded = await this.loadExpandedConfig(command);
    const parsed = analyzeSshConfigLines(expanded.lines, expanded.notices);
    if (parsed.hosts.length > MAX_IMPORTED_HOSTS)
      throw new ApplicationError(
        'INVALID_STATE',
        `SSH config contains more than ${MAX_IMPORTED_HOSTS} importable hosts`,
        409,
      );
    const items = this.previewItems(parsed);
    const previewId = randomUUID();
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    this.prunePreviews();
    while (this.previews.size >= MAX_PREVIEWS)
      this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(previewId, { expiresAt, parsed });
    return {
      previewId,
      expiresAt: new Date(expiresAt).toISOString(),
      sourceName: expanded.sourceName,
      items,
      includes: expanded.includes,
      notices: parsed.notices,
      summary: previewSummary(items, parsed.notices),
    };
  }

  commitPreview(
    input: CommitSshConfigImportInput,
    treeIfMatch: string | undefined,
  ): SshConfigImportResult {
    const command = commitSshConfigImportSchema.parse(input);
    this.prunePreviews();
    const cached = this.previews.get(command.previewId);
    if (!cached)
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'SSH Config preview expired; preview the granted files again',
        412,
      );
    const byId = new Map(cached.parsed.hosts.map((item) => [item.id, item]));
    const submitted = new Map<string, SshConfigImportDraft>();
    for (const raw of command.items) {
      const draft = sshConfigImportDraftSchema.parse(raw);
      if (!byId.has(draft.id))
        throw new ApplicationError(
          'INVALID_STATE',
          'Preview item is not part of the current preview batch',
          409,
        );
      if (submitted.has(draft.id))
        throw new ApplicationError('INVALID_STATE', 'Preview item was submitted twice', 409);
      submitted.set(draft.id, draft);
    }
    const excluded: SshConfigImportItem[] = [];
    const hosts: AnalyzedHost[] = [];
    for (const base of cached.parsed.hosts) {
      const draft = submitted.get(base.id);
      if (!draft?.selected) {
        excluded.push({
          index: base.index,
          line: base.line,
          alias: base.name,
          status: 'skipped',
          hostId: null,
          bookmarkId: null,
          proxyJumps: base.proxyJumps,
          notices: [
            ...base.notices.slice(0, MAX_ITEM_NOTICES - 1),
            notice('USER_EXCLUDED', base.line, 'Entry was excluded from the confirmed preview'),
          ],
        });
        continue;
      }
      hosts.push({
        ...base,
        name: draft.name,
        title: draft.title,
        description: draft.description,
        hostname: draft.hostname,
        port: draft.port,
        username: draft.username,
        authType: draft.authType,
        proxy: draft.proxy,
        proxyJumps: draft.proxyJumps,
        connectionOptions: draft.connectionOptions,
      });
    }
    const parsed: ParsedSshConfig = {
      hosts,
      skipped: [...cached.parsed.skipped, ...excluded].sort(
        (left, right) => left.index - right.index,
      ),
      notices: cached.parsed.notices,
      sourceNames: cached.parsed.sourceNames,
    };
    const result = this.unitOfWork.transaction(() =>
      this.commit(parsed, command.groupId ?? null, treeIfMatch),
    );
    this.previews.delete(command.previewId);
    return result;
  }

  private async loadExpandedConfig(command: PreviewSshConfigImportInput): Promise<ExpandedConfig> {
    if (!this.host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File grants are unavailable', 503);
    const bindings = new Map<string, string>();
    for (const binding of command.includeGrants ?? []) {
      if (bindings.has(binding.includeId))
        throw new ApplicationError(
          'INVALID_STATE',
          'Each Include can have only one active file grant',
          409,
        );
      bindings.set(binding.includeId, binding.grantId);
    }
    const root = await this.host.resolveGrant(command.grantId);
    assertReadableGrant(root, 'file');
    const state: ExpansionState = {
      host: this.host,
      bindings,
      usedBindings: new Set(),
      includes: [],
      notices: [],
      lines: [],
      budget: { bytes: 0, files: 0 },
    };
    try {
      await expandGrantedFile(root.path, root.name, 'root', 0, new Set(), state);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('INVALID_STATE', 'Granted SSH config cannot be read', 409);
    }
    for (const includeId of bindings.keys())
      if (!state.usedBindings.has(includeId))
        throw new ApplicationError(
          'INVALID_STATE',
          `Include grant “${includeId}” does not belong to the current preview`,
          409,
        );
    return {
      lines: state.lines,
      includes: state.includes,
      notices: state.notices,
      sourceName: root.name,
    };
  }

  private previewItems(parsed: ParsedSshConfig): SshConfigImportPreviewItem[] {
    const existingHosts = this.repository.listHosts();
    const existingByName = uniqueHostLookup(existingHosts, (host) => host.name);
    const tree = this.bookmarks.snapshot();
    const bookmarkedHostIds = new Set(
      tree.bookmarks.flatMap((bookmark) => (bookmark.hostId ? [bookmark.hostId] : [])),
    );
    const plans = new Map<string, PlannedHost>();
    const duplicateIds = new Set<string>();
    const firstByAlias = new Map<string, AnalyzedHost>();
    for (const item of parsed.hosts) {
      const alias = item.name.toLocaleLowerCase();
      const previous = firstByAlias.get(alias);
      if (previous) {
        duplicateIds.add(item.id);
        continue;
      }
      firstByAlias.set(alias, item);
      const existing = existingByName.get(alias);
      plans.set(alias, {
        parsed: item,
        ...(existing ? { existing } : {}),
        desiredJumpAlias: null,
      });
    }
    const aliases = aliasResolver(plans, existingHosts);
    const jumpProblems = previewJumpProblems(plans, existingHosts, aliases.resolve);
    return [
      ...parsed.hosts.map((item): SshConfigImportPreviewItem => {
        const existing = existingByName.get(item.name.toLocaleLowerCase());
        const duplicate = duplicateIds.has(item.id);
        const incompatible = !!existing && !sameExistingConnection(existing, item);
        const itemJumpProblems = jumpProblems.get(item.id) ?? [];
        const status =
          duplicate || incompatible || itemJumpProblems.length
            ? 'skipped'
            : !existing
              ? 'imported'
              : bookmarkedHostIds.has(existing.id)
                ? 'unchanged'
                : 'linked';
        const previewNotices = [...item.notices];
        if (duplicate)
          previewNotices.push(
            notice(
              'DUPLICATE_ALIAS_SKIPPED',
              item.line,
              `Duplicate alias “${item.name}” is already present in this preview`,
            ),
          );
        if (incompatible)
          previewNotices.push(
            notice(
              'CONFLICTING_HOST_SKIPPED',
              item.line,
              `Saved Host “${item.name}” has different connection settings`,
            ),
          );
        previewNotices.push(...itemJumpProblems);
        return {
          id: item.id,
          index: item.index,
          line: item.line,
          sourceName: item.sourceName,
          alias: item.name,
          status,
          draft: importDraft(item, status === 'imported' || status === 'linked'),
          notices: previewNotices.slice(0, MAX_ITEM_NOTICES),
        };
      }),
      ...parsed.skipped.map((item): SshConfigImportPreviewItem => ({
        id: `skipped-${item.index}`,
        index: item.index,
        line: item.line,
        sourceName: parsed.sourceNames.get(item.index) ?? 'SSH Config',
        alias: item.alias,
        status: 'skipped',
        draft: null,
        notices: item.notices,
      })),
    ].sort((left, right) => left.index - right.index);
  }

  private prunePreviews(now = Date.now()): void {
    for (const [id, preview] of this.previews)
      if (preview.expiresAt <= now) this.previews.delete(id);
  }

  async import(
    input: ImportHostsInput,
    treeIfMatch: string | undefined,
  ): Promise<SshConfigImportResult> {
    const command = importHostsSchema.parse(input);
    if (!this.host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File grants are unavailable', 503);
    const grant = await this.host.resolveGrant(command.grantId);
    if (!grant.permissions.includes('read') || grant.kind !== 'file')
      throw new ApplicationError('INVALID_STATE', 'A readable file grant is required', 409);
    let source: string;
    try {
      source = await readBoundedConfig(grant.path);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('INVALID_STATE', 'Granted SSH config cannot be read', 409);
    }
    const parsed = analyzeSshConfig(source);
    if (parsed.hosts.length > MAX_IMPORTED_HOSTS)
      throw new ApplicationError(
        'INVALID_STATE',
        `SSH config contains more than ${MAX_IMPORTED_HOSTS} importable hosts`,
        409,
      );
    return this.unitOfWork.transaction(() =>
      this.commit(parsed, command.groupId ?? null, treeIfMatch),
    );
  }

  private commit(
    parsed: ParsedSshConfig,
    groupId: string | null,
    treeIfMatch: string | undefined,
  ): SshConfigImportResult {
    // Check the tree before writing a Host. The batch repository checks it again
    // before Bookmark insertion; the enclosing UnitOfWork makes either failure atomic.
    this.bookmarks.assertMutationTarget(groupId, treeIfMatch);
    const treeBefore = this.bookmarks.snapshot();
    const existingHosts = this.repository.listHosts();
    const existingByName = uniqueHostLookup(existingHosts, (host) => host.name);
    const sourceByName = new Map<string, AnalyzedHost>();
    const duplicateItems: SshConfigImportItem[] = [];

    for (const item of parsed.hosts) {
      const previous = sourceByName.get(item.name.toLocaleLowerCase());
      if (!previous) {
        sourceByName.set(item.name.toLocaleLowerCase(), item);
        continue;
      }
      if (!sameParsedConnection(previous, item))
        throw new ApplicationError(
          'CONFLICT',
          `SSH config alias “${item.name}” is defined with conflicting connection facts`,
          409,
        );
      duplicateItems.push({
        index: item.index,
        line: item.line,
        alias: item.name,
        status: 'skipped',
        hostId: null,
        bookmarkId: null,
        proxyJumps: item.proxyJumps,
        notices: [
          notice(
            'DUPLICATE_ALIAS_SKIPPED',
            item.line,
            `Duplicate alias “${item.name}” matches an earlier entry and was skipped`,
          ),
        ],
      });
    }

    const unique = [...sourceByName.values()];
    const plans = new Map<string, PlannedHost>();
    for (const item of unique) {
      const existing = existingByName.get(item.name.toLocaleLowerCase());
      if (
        existing &&
        (existing.hostname !== item.hostname ||
          existing.port !== item.port ||
          existing.username !== item.username ||
          existing.authType !== item.authType ||
          JSON.stringify(existing.proxy) !== JSON.stringify(item.proxy) ||
          JSON.stringify(existing.connectionOptions) !== JSON.stringify(item.connectionOptions))
      )
        throw new ApplicationError(
          'CONFLICT',
          `Host “${item.name}” already exists with different connection facts`,
          409,
        );
      plans.set(item.name.toLocaleLowerCase(), {
        parsed: item,
        ...(existing ? { existing } : {}),
        desiredJumpAlias: null,
      });
    }

    const aliases = aliasResolver(plans, existingHosts);
    const desiredEdges = new Map<string, string>();
    const setDesiredEdge = (sourceAlias: string, targetAlias: string, line: number) => {
      if (sourceAlias === targetAlias)
        throw new ApplicationError('CONFLICT', `ProxyJump cycle detected at “${sourceAlias}”`, 409);
      const previous = desiredEdges.get(sourceAlias);
      if (previous && previous !== targetAlias)
        throw new ApplicationError(
          'CONFLICT',
          `ProxyJump for “${sourceAlias}” resolves to both “${previous}” and “${targetAlias}” near line ${line}`,
          409,
        );
      desiredEdges.set(sourceAlias, targetAlias);
    };

    for (const plan of plans.values()) {
      let previousAlias: string | undefined;
      for (const rawJump of plan.parsed.proxyJumps) {
        const jumpAlias = aliases.resolve(rawJump);
        if (!jumpAlias)
          throw new ApplicationError(
            'CONFLICT',
            `ProxyJump “${rawJump}” for “${plan.parsed.name}” does not reference an imported or existing Host`,
            409,
          );
        if (previousAlias) setDesiredEdge(jumpAlias, previousAlias, plan.parsed.line);
        previousAlias = jumpAlias;
      }
      if (previousAlias)
        setDesiredEdge(plan.parsed.name.toLocaleLowerCase(), previousAlias, plan.parsed.line);
    }
    for (const [alias, plan] of plans) plan.desiredJumpAlias = desiredEdges.get(alias) ?? null;

    assertNoJumpCycle(plans, existingHosts);
    for (const plan of plans.values()) {
      if (!plan.existing) continue;
      const desiredTarget = plan.desiredJumpAlias
        ? (plans.get(plan.desiredJumpAlias)?.existing ?? existingByName.get(plan.desiredJumpAlias))
        : undefined;
      if (plan.desiredJumpAlias && !desiredTarget)
        throw new ApplicationError(
          'CONFLICT',
          `Existing Host “${plan.parsed.name}” cannot be rebound to a newly imported ProxyJump`,
          409,
        );
      if (plan.existing.jumpHostId !== (desiredTarget?.id ?? null))
        throw new ApplicationError(
          'CONFLICT',
          `Host “${plan.parsed.name}” already exists with a different ProxyJump`,
          409,
        );
    }

    const createdHosts: Host[] = [];
    const resolvedHosts = new Map<string, Host>();
    for (const [alias, plan] of plans) if (plan.existing) resolvedHosts.set(alias, plan.existing);
    for (const plan of topologicalNewHosts(plans)) {
      const jumpHost = plan.desiredJumpAlias
        ? (resolvedHosts.get(plan.desiredJumpAlias) ?? existingByName.get(plan.desiredJumpAlias))
        : undefined;
      if (plan.desiredJumpAlias && !jumpHost)
        throw new ApplicationError('INVALID_STATE', 'Resolved ProxyJump Host is unavailable', 409);
      const host = this.repository.createHost({
        groupId: null,
        name: plan.parsed.name,
        hostname: plan.parsed.hostname,
        port: plan.parsed.port,
        username: plan.parsed.username,
        authType: plan.parsed.authType,
        credentialRef: null,
        passphraseCredentialRef: null,
        jumpHostId: jumpHost?.id ?? null,
        favorite: false,
        proxy: plan.parsed.proxy,
        connectionOptions: plan.parsed.connectionOptions,
      });
      createdHosts.push(host);
      resolvedHosts.set(plan.parsed.name.toLocaleLowerCase(), host);
    }

    const existingBookmarkByHost = new Map(
      treeBefore.bookmarks
        .filter((bookmark) => bookmark.hostId)
        .map((bookmark) => [bookmark.hostId!, bookmark]),
    );
    const bookmarkPlans = unique.filter((item) => {
      const host = resolvedHosts.get(item.name.toLocaleLowerCase());
      if (!host) throw new ApplicationError('INVALID_STATE', 'Imported Host is unavailable', 409);
      return !existingBookmarkByHost.has(host.id);
    });
    const batch = this.bookmarks.createBookmarksBatch(
      bookmarkPlans.map((item) => ({
        groupId,
        protocol: 'ssh' as const,
        hostId: resolvedHosts.get(item.name.toLocaleLowerCase())!.id,
        title: item.title,
        color: null,
        description: item.description,
        profileId: null,
      })),
      treeIfMatch,
    );
    const createdBookmarkByHost = new Map(
      batch.bookmarks.map((bookmark) => [bookmark.hostId!, bookmark]),
    );
    const createdHostIds = new Set(createdHosts.map(({ id }) => id));
    const items: SshConfigImportItem[] = [
      ...unique.map((item): SshConfigImportItem => {
        const host = resolvedHosts.get(item.name.toLocaleLowerCase());
        if (!host) throw new ApplicationError('INVALID_STATE', 'Imported Host is unavailable', 409);
        const createdBookmark = createdBookmarkByHost.get(host.id);
        const existingBookmark = existingBookmarkByHost.get(host.id);
        return {
          index: item.index,
          line: item.line,
          alias: item.name,
          status: createdHostIds.has(host.id)
            ? 'imported'
            : createdBookmark
              ? 'linked'
              : 'unchanged',
          hostId: host.id,
          bookmarkId: createdBookmark?.id ?? existingBookmark?.id ?? null,
          proxyJumps: item.proxyJumps,
          notices: item.notices,
        };
      }),
      ...duplicateItems,
      ...parsed.skipped,
    ].sort((left, right) => left.index - right.index);
    const summary = {
      total: items.length,
      imported: items.filter(({ status }) => status === 'imported').length,
      linked: items.filter(({ status }) => status === 'linked').length,
      unchanged: items.filter(({ status }) => status === 'unchanged').length,
      skipped: items.filter(({ status }) => status === 'skipped').length,
      warningCount:
        parsed.notices.length + items.reduce((count, item) => count + item.notices.length, 0),
    };
    return {
      source: 'ssh-config',
      importedAt: new Date().toISOString(),
      createdHosts,
      createdBookmarks: batch.bookmarks,
      tree: batch.tree,
      items,
      notices: parsed.notices,
      summary,
    };
  }
}

function importDraft(item: AnalyzedHost, selected: boolean): SshConfigImportDraft {
  return sshConfigImportDraftSchema.parse({
    id: item.id,
    selected,
    name: item.name,
    title: item.title,
    description: item.description,
    hostname: item.hostname,
    port: item.port,
    username: item.username,
    authType: item.authType,
    proxy: item.proxy,
    proxyJumps: item.proxyJumps,
    connectionOptions: item.connectionOptions,
  });
}

function sameExistingConnection(existing: Host, item: AnalyzedHost): boolean {
  return (
    existing.hostname === item.hostname &&
    existing.port === item.port &&
    existing.username === item.username &&
    existing.authType === item.authType &&
    JSON.stringify(existing.proxy) === JSON.stringify(item.proxy) &&
    JSON.stringify(existing.connectionOptions) === JSON.stringify(item.connectionOptions)
  );
}

function previewSummary(
  items: SshConfigImportPreviewItem[],
  notices: SshConfigImportNotice[],
): SshConfigImportPreview['summary'] {
  return {
    total: items.length,
    imported: items.filter(({ status }) => status === 'imported').length,
    linked: items.filter(({ status }) => status === 'linked').length,
    unchanged: items.filter(({ status }) => status === 'unchanged').length,
    skipped: items.filter(({ status }) => status === 'skipped').length,
    warningCount: notices.length + items.reduce((sum, item) => sum + item.notices.length, 0),
    selected: items.filter(({ draft }) => draft?.selected).length,
  };
}

function assertReadableGrant(grant: ResolvedGrant, requiredKind?: 'file'): void {
  if (!grant.permissions.includes('read') || (requiredKind && grant.kind !== requiredKind))
    throw new ApplicationError('INVALID_STATE', 'A readable file grant is required', 409);
  if (grant.kind !== 'file' && grant.kind !== 'directory')
    throw new ApplicationError(
      'INVALID_STATE',
      'A readable file or directory grant is required',
      409,
    );
}

function pushExpansionNotice(state: ExpansionState, value: SshConfigImportNotice): void {
  if (state.notices.length < 256) state.notices.push(value);
}

async function expandGrantedFile(
  path: string,
  sourceName: string,
  sourceKey: string,
  depth: number,
  ancestors: Set<string>,
  state: ExpansionState,
): Promise<void> {
  const canonical = await realpath(path);
  const nextAncestors = new Set(ancestors).add(canonical);
  const source = await readBoundedConfig(path, state.budget);
  let includeOrdinal = 0;
  for (const [offset, raw] of source.split(/\r?\n/).entries()) {
    const line = offset + 1;
    const directive = parseDirective(raw);
    if (directive?.name.toLocaleLowerCase() !== 'include') {
      state.lines.push({ text: raw, line, sourceName: sourceName.slice(0, 255) });
      continue;
    }
    const expressions = splitWords(directive.value);
    for (const [expressionIndex, rawExpression] of expressions.entries()) {
      const expression = rawExpression.slice(0, 1_024);
      const pattern = safeIncludePattern(expression);
      const includeId = `${sourceKey}/i${includeOrdinal}-${expressionIndex}`;
      if (state.includes.length >= MAX_INCLUDE_REQUESTS) {
        pushExpansionNotice(
          state,
          notice(
            'INCLUDE_LIMIT_EXCEEDED',
            line,
            `Only ${MAX_INCLUDE_REQUESTS} Include entries can be previewed`,
          ),
        );
        continue;
      }
      if (depth >= MAX_INCLUDE_DEPTH) {
        const limitNotice = notice(
          'INCLUDE_LIMIT_EXCEEDED',
          line,
          `Include recursion is limited to ${MAX_INCLUDE_DEPTH} levels`,
        );
        state.includes.push({
          id: includeId,
          sourceName: sourceName.slice(0, 255),
          line,
          pattern,
          status: 'skipped',
          grantName: null,
          fileCount: 0,
          notice: limitNotice,
        });
        pushExpansionNotice(state, limitNotice);
        continue;
      }
      const grantId = state.bindings.get(includeId);
      if (!grantId) {
        const required = notice(
          'INCLUDE_AUTHORIZATION_REQUIRED',
          line,
          'Select this Include file or directory to add it to the preview',
        );
        state.includes.push({
          id: includeId,
          sourceName: sourceName.slice(0, 255),
          line,
          pattern,
          status: 'authorization-required',
          grantName: null,
          fileCount: 0,
          notice: required,
        });
        pushExpansionNotice(state, required);
        continue;
      }
      state.usedBindings.add(includeId);
      let grant: ResolvedGrant;
      try {
        grant = await state.host.resolveGrant(grantId);
        assertReadableGrant(grant);
      } catch {
        const invalid = notice(
          'INCLUDE_GRANT_INVALID',
          line,
          'The selected Include grant is unavailable or is not readable',
        );
        state.includes.push({
          id: includeId,
          sourceName: sourceName.slice(0, 255),
          line,
          pattern,
          status: 'skipped',
          grantName: null,
          fileCount: 0,
          notice: invalid,
        });
        pushExpansionNotice(state, invalid);
        continue;
      }
      const paths =
        grant.kind === 'file'
          ? [grant.path]
          : await collectGrantedIncludeFiles(grant.path, expression);
      let cycleNotice: SshConfigImportNotice | null = null;
      let expanded = 0;
      for (const [fileIndex, includedPath] of paths.entries()) {
        const includedCanonical = await realpath(includedPath);
        if (nextAncestors.has(includedCanonical)) {
          cycleNotice = notice(
            'INCLUDE_CYCLE_SKIPPED',
            line,
            'An Include cycle was detected and the repeated file was skipped',
          );
          pushExpansionNotice(state, cycleNotice);
          continue;
        }
        await expandGrantedFile(
          includedPath,
          basename(includedPath),
          `${includeId}/f${fileIndex}`,
          depth + 1,
          nextAncestors,
          state,
        );
        expanded += 1;
      }
      state.includes.push({
        id: includeId,
        sourceName: sourceName.slice(0, 255),
        line,
        pattern,
        status: expanded ? 'authorized' : 'skipped',
        grantName: grant.name.slice(0, 255),
        fileCount: expanded,
        notice:
          cycleNotice ??
          (expanded
            ? null
            : notice('INCLUDE_GRANT_INVALID', line, 'No matching regular files were selected')),
      });
    }
    includeOrdinal += 1;
  }
}

async function collectGrantedIncludeFiles(
  directory: string,
  expression: string,
): Promise<string[]> {
  const pattern = expression.replaceAll('\\', '/').split('/').pop() || '*';
  const matches = globMatcher(pattern);
  const recursive = expression.includes('**');
  const output: string[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH) return;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const target = join(path, entry.name);
      if (entry.isDirectory() && recursive) await visit(target, depth + 1);
      else if (entry.isFile() && matches(entry.name)) {
        output.push(target);
        if (output.length > MAX_INCLUDE_FILES)
          throw new ApplicationError(
            'INVALID_STATE',
            `An Include may resolve at most ${MAX_INCLUDE_FILES} files`,
            409,
          );
      }
    }
  };
  await visit(directory, 0);
  return output;
}

function globMatcher(pattern: string): (value: string) => boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replaceAll('*', '.*').replaceAll('?', '.');
  const expression = new RegExp(`^${source}$`);
  return (value) => expression.test(value);
}

function safeIncludePattern(expression: string): string {
  const normalized = expression.replaceAll('\\', '/');
  return (normalized.split('/').filter(Boolean).pop() || '(include)').slice(0, 255);
}

async function readBoundedConfig(path: string, budget?: ReadBudget): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new ApplicationError('INVALID_STATE', 'SSH config grant is not a file', 409);
    if (metadata.size > MAX_CONFIG_BYTES)
      throw new ApplicationError('INVALID_STATE', 'SSH config exceeds the import limit', 409);
    if (
      budget &&
      (budget.files >= MAX_INCLUDE_FILES || budget.bytes + metadata.size > MAX_CONFIG_BYTES)
    )
      throw new ApplicationError(
        'INVALID_STATE',
        'Authorized SSH config files exceed the bounded preview budget',
        409,
      );
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset <= MAX_CONFIG_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        Math.min(64 * 1024, MAX_CONFIG_BYTES + 1 - offset),
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_CONFIG_BYTES)
      throw new ApplicationError('INVALID_STATE', 'SSH config exceeds the import limit', 409);
    if (budget) {
      budget.files += 1;
      budget.bytes += offset;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function parseSshConfig(source: string): Array<{
  name: string;
  hostname: string;
  username: string;
  port: number;
  proxyJump?: string;
}> {
  return analyzeSshConfig(source).hosts.map((host) => ({
    name: host.name,
    hostname: host.hostname,
    username: host.username,
    port: host.port,
    ...(host.proxyJumps[0] ? { proxyJump: host.proxyJumps[0] } : {}),
  }));
}

function analyzeSshConfig(source: string): ParsedSshConfig {
  return analyzeSshConfigLines(
    source.split(/\r?\n/).map((text, index) => ({
      text,
      line: index + 1,
      sourceName: 'config',
    })),
    [],
  );
}

function analyzeSshConfigLines(
  lines: SourceLine[],
  initialNotices: SshConfigImportNotice[],
): ParsedSshConfig {
  const blocks: RawHostBlock[] = [];
  const notices: SshConfigImportNotice[] = [...initialNotices];
  let current: RawHostBlock | undefined;
  let blockIndex = 0;
  for (const sourceLine of lines) {
    const lineNumber = sourceLine.line;
    const directive = parseDirective(sourceLine.text);
    if (!directive) continue;
    const name = directive.name.toLocaleLowerCase();
    if (name === 'include') {
      if (notices.length < 256)
        notices.push(
          notice(
            'INCLUDE_NOT_FOLLOWED',
            lineNumber,
            'Include was not followed because this import is limited to the granted file',
          ),
        );
      continue;
    }
    if (name === 'match') {
      current = undefined;
      if (notices.length < 256)
        notices.push(
          notice(
            'UNSUPPORTED_OPTION',
            lineNumber,
            'Match section conditions were not applied to imported saved destinations',
          ),
        );
      continue;
    }
    if (name === 'host') {
      current = {
        id: `entry-${blockIndex}`,
        index: blockIndex,
        line: lineNumber,
        sourceName: sourceLine.sourceName,
        expression: directive.value,
        fields: new Map(),
        unsupported: [],
      };
      blocks.push(current);
      blockIndex += 1;
      if (blocks.length > MAX_HOST_BLOCKS)
        throw new ApplicationError(
          'INVALID_STATE',
          `SSH config contains more than ${MAX_HOST_BLOCKS} Host blocks`,
          409,
        );
      continue;
    }
    if (!current) continue;
    if (
      [
        'hostname',
        'user',
        'port',
        'proxyjump',
        'identityfile',
        'proxycommand',
        'forwardagent',
        'identityagent',
        'identitiesonly',
        'serveraliveinterval',
        'serveralivecountmax',
        'compression',
        'connecttimeout',
        'connectionattempts',
      ].includes(name)
    )
      current.fields.set(name, { value: directive.value, line: lineNumber });
    else if (current.unsupported.length < MAX_ITEM_NOTICES)
      current.unsupported.push({ name: directive.name, line: lineNumber });
  }

  const defaults = blocks.find(({ expression }) => expression.trim() === '*');
  const hosts: AnalyzedHost[] = [];
  const skipped: SshConfigImportItem[] = [];
  for (const block of blocks) {
    const expression = block.expression.trim();
    if (expression === '*') continue;
    const names = splitWords(expression);
    const displayAlias = boundedAlias(names[0] ?? expression);
    const itemNotices: SshConfigImportNotice[] = [];
    if (names.length !== 1) {
      itemNotices.push(
        notice(
          'MULTI_ALIAS_HOST_SKIPPED',
          block.line,
          'Host blocks with multiple aliases are not imported as one saved destination',
        ),
      );
      skipped.push(skippedItem(block, displayAlias, itemNotices));
      continue;
    }
    const alias = names[0]!;
    if (/[*!?]/.test(alias)) {
      itemNotices.push(
        notice(
          'WILDCARD_HOST_SKIPPED',
          block.line,
          `Pattern Host “${boundedAlias(alias)}” was skipped`,
        ),
      );
      skipped.push(skippedItem(block, boundedAlias(alias), itemNotices));
      continue;
    }
    if (alias.length > 100) {
      itemNotices.push(
        notice('UNSUPPORTED_OPTION', block.line, 'Host alias exceeds the 100 character limit'),
      );
      skipped.push(skippedItem(block, boundedAlias(alias), itemNotices));
      continue;
    }
    const hostname = field(block, defaults, 'hostname')?.value ?? alias;
    const username = field(block, defaults, 'user')?.value.trim() ?? '';
    const portField = field(block, defaults, 'port');
    const port = portField ? Number(portField.value) : 22;
    if (!username || username.length > 128) {
      itemNotices.push(
        notice(
          'MISSING_USERNAME',
          field(block, defaults, 'user')?.line ?? block.line,
          username ? 'SSH username exceeds the supported limit' : 'SSH username is required',
        ),
      );
      skipped.push(skippedItem(block, alias, itemNotices));
      continue;
    }
    if (!hostname.trim() || hostname.length > 253) {
      itemNotices.push(
        notice(
          'UNSUPPORTED_OPTION',
          block.line,
          hostname.trim()
            ? 'SSH hostname exceeds the supported limit'
            : 'SSH hostname cannot be empty',
        ),
      );
      skipped.push(skippedItem(block, alias, itemNotices));
      continue;
    }
    if (
      (portField && !/^\d+$/.test(portField.value)) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      itemNotices.push(
        notice('INVALID_PORT', portField?.line ?? block.line, 'SSH port must be from 1 to 65535'),
      );
      skipped.push(skippedItem(block, alias, itemNotices));
      continue;
    }
    const proxyField = field(block, defaults, 'proxyjump');
    const proxyJumps =
      !proxyField || proxyField.value.toLocaleLowerCase() === 'none'
        ? []
        : proxyField.value
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    if (
      (proxyField && proxyField.value.toLocaleLowerCase() !== 'none' && !proxyJumps.length) ||
      proxyJumps.length > MAX_PROXY_HOPS ||
      proxyJumps.some((value) => value.length > 253)
    ) {
      itemNotices.push(
        notice(
          'UNSUPPORTED_OPTION',
          proxyField?.line ?? block.line,
          `ProxyJump must contain 1–${MAX_PROXY_HOPS} bounded destinations`,
        ),
      );
      skipped.push(skippedItem(block, alias, itemNotices));
      continue;
    }
    const identity = field(block, defaults, 'identityfile');
    if (identity)
      itemNotices.push(
        notice(
          'IDENTITY_FILE_NOT_IMPORTED',
          identity.line,
          'IdentityFile was reported but not read outside the granted file',
        ),
      );
    const proxyCommand = field(block, defaults, 'proxycommand');
    if (proxyCommand)
      itemNotices.push(
        notice(
          'PROXY_COMMAND_NOT_IMPORTED',
          proxyCommand.line,
          'ProxyCommand requires the dedicated validated adapter and was not imported',
        ),
      );
    const connectTimeout = mappedIntegerOption(
      field(block, defaults, 'connecttimeout'),
      1,
      300,
      'ConnectTimeout',
      itemNotices,
    );
    const keepaliveInterval = mappedIntegerOption(
      field(block, defaults, 'serveraliveinterval'),
      0,
      300,
      'ServerAliveInterval',
      itemNotices,
    );
    const keepaliveCount = mappedIntegerOption(
      field(block, defaults, 'serveralivecountmax'),
      1,
      100,
      'ServerAliveCountMax',
      itemNotices,
    );
    const connectionAttempts = mappedIntegerOption(
      field(block, defaults, 'connectionattempts'),
      1,
      20,
      'ConnectionAttempts',
      itemNotices,
    );
    const compression = mappedBooleanOption(
      field(block, defaults, 'compression'),
      'Compression',
      itemNotices,
    );
    const identityAgent = field(block, defaults, 'identityagent');
    const forwardAgent = mappedBooleanOption(
      field(block, defaults, 'forwardagent'),
      'ForwardAgent',
      itemNotices,
    );
    const identitiesOnly = mappedBooleanOption(
      field(block, defaults, 'identitiesonly'),
      'IdentitiesOnly',
      itemNotices,
    );
    const authType: Host['authType'] =
      identity && identitiesOnly !== false && !identityAgent && !forwardAgent
        ? 'privateKey'
        : 'agent';
    const connectionOptions: Host['connectionOptions'] = {
      connectionTimeoutMs:
        connectTimeout === undefined
          ? DEFAULT_SSH_CONNECTION_OPTIONS.connectionTimeoutMs
          : connectTimeout * 1_000,
      keepaliveIntervalMs:
        keepaliveInterval === undefined
          ? DEFAULT_SSH_CONNECTION_OPTIONS.keepaliveIntervalMs
          : keepaliveInterval * 1_000,
      keepaliveCountMax: keepaliveCount ?? DEFAULT_SSH_CONNECTION_OPTIONS.keepaliveCountMax,
      compression: compression ?? DEFAULT_SSH_CONNECTION_OPTIONS.compression,
      algorithms: {
        kex: [],
        cipher: [],
        serverHostKey: [],
        hmac: [],
      },
      reconnectPolicy: connectionAttempts
        ? {
            mode: connectionAttempts > 1 ? 'automatic' : 'manual',
            delayMs: DEFAULT_SSH_CONNECTION_OPTIONS.reconnectPolicy.delayMs,
            maxAttempts: connectionAttempts,
          }
        : DEFAULT_SSH_CONNECTION_OPTIONS.reconnectPolicy,
    };
    for (const unsupported of [...(defaults?.unsupported ?? []), ...block.unsupported].slice(
      0,
      MAX_ITEM_NOTICES - itemNotices.length,
    ))
      itemNotices.push(
        notice(
          'UNSUPPORTED_OPTION',
          unsupported.line,
          `SSH option “${unsupported.name}” is not mapped by this importer`,
        ),
      );
    hosts.push({
      id: block.id,
      index: block.index,
      line: block.line,
      sourceName: block.sourceName,
      name: alias,
      title: alias,
      description: hostname !== alias ? `SSH to ${hostname}`.slice(0, 1_024) : '',
      hostname,
      username,
      port,
      authType,
      proxy: DEFAULT_HOST_PROXY,
      proxyJumps,
      connectionOptions,
      notices: itemNotices,
    });
  }
  return {
    hosts,
    skipped,
    notices,
    sourceNames: new Map(blocks.map((block) => [block.index, block.sourceName])),
  };
}

function field(
  block: RawHostBlock,
  defaults: RawHostBlock | undefined,
  name: string,
): { value: string; line: number } | undefined {
  return block.fields.get(name) ?? defaults?.fields.get(name);
}

function mappedIntegerOption(
  option: { value: string; line: number } | undefined,
  minimum: number,
  maximum: number,
  label: string,
  notices: SshConfigImportNotice[],
): number | undefined {
  if (!option) return undefined;
  const value = Number(option.value);
  if (/^\d+$/.test(option.value) && Number.isInteger(value) && value >= minimum && value <= maximum)
    return value;
  notices.push(
    notice(
      'INVALID_OPTION',
      option.line,
      `${label} must be an integer from ${minimum} to ${maximum}; the Axterm default is used`,
    ),
  );
  return undefined;
}

function mappedBooleanOption(
  option: { value: string; line: number } | undefined,
  label: string,
  notices: SshConfigImportNotice[],
): boolean | undefined {
  if (!option) return undefined;
  const value = option.value.toLocaleLowerCase();
  if (['yes', 'true', 'on'].includes(value)) return true;
  if (['no', 'false', 'off'].includes(value)) return false;
  notices.push(
    notice('INVALID_OPTION', option.line, `${label} must be yes or no; the Axterm default is used`),
  );
  return undefined;
}

function skippedItem(
  block: RawHostBlock,
  alias: string,
  notices: SshConfigImportNotice[],
): SshConfigImportItem {
  return {
    index: block.index,
    line: block.line,
    alias,
    status: 'skipped',
    hostId: null,
    bookmarkId: null,
    proxyJumps: [],
    notices,
  };
}

function notice(
  code: SshConfigImportNotice['code'],
  line: number,
  message: string,
): SshConfigImportNotice {
  return { code, line, message: message.slice(0, 240) };
}

function parseDirective(raw: string): { name: string; value: string } | undefined {
  const line = stripInlineComment(raw).trim();
  if (!line) return undefined;
  const match = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
  if (!match) return undefined;
  return { name: match[1]!, value: unquote(match[2]!.trim()) };
}

function stripInlineComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if ((character === '"' || character === "'") && raw[index - 1] !== '\\')
      quote = quote === character ? undefined : (quote ?? character);
    if (character === '#' && !quote && (index === 0 || /\s/.test(raw[index - 1]!)))
      return raw.slice(0, index);
  }
  return raw;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  )
    return value.slice(1, -1);
  return value;
}

function splitWords(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function boundedAlias(value: string): string {
  const normalized = value.trim() || '(unnamed)';
  return normalized.slice(0, 100);
}

function sameParsedConnection(left: AnalyzedHost, right: AnalyzedHost): boolean {
  return (
    left.hostname === right.hostname &&
    left.username === right.username &&
    left.port === right.port &&
    left.proxyJumps.join('\u0000') === right.proxyJumps.join('\u0000')
  );
}

function uniqueHostLookup(hosts: Host[], key: (host: Host) => string): Map<string, Host> {
  const output = new Map<string, Host>();
  for (const host of hosts) {
    const normalized = key(host).toLocaleLowerCase();
    if (!output.has(normalized)) output.set(normalized, host);
  }
  return output;
}

function aliasResolver(plans: Map<string, PlannedHost>, existingHosts: Host[]) {
  const hostnameAliases = new Map<string, Set<string>>();
  const addHostname = (hostname: string, alias: string) => {
    const key = hostname.toLocaleLowerCase();
    hostnameAliases.set(key, new Set([...(hostnameAliases.get(key) ?? []), alias]));
  };
  for (const [alias, plan] of plans) addHostname(plan.parsed.hostname, alias);
  for (const host of existingHosts) addHostname(host.hostname, host.name.toLocaleLowerCase());
  const existingNames = new Set(existingHosts.map(({ name }) => name.toLocaleLowerCase()));
  return {
    resolve(raw: string): string | undefined {
      const direct = raw.toLocaleLowerCase();
      if (plans.has(direct) || existingNames.has(direct)) return direct;
      const destination = /^(?:[^@\s]+@)?(\[[^\]]+\]|[^:\s]+)(?::\d+)?$/.exec(raw)?.[1];
      if (!destination) return undefined;
      const normalized = destination.replace(/^\[|\]$/g, '').toLocaleLowerCase();
      if (plans.has(normalized) || existingNames.has(normalized)) return normalized;
      const matches = hostnameAliases.get(normalized);
      return matches?.size === 1 ? [...matches][0] : undefined;
    },
  };
}

function previewJumpProblems(
  plans: Map<string, PlannedHost>,
  existingHosts: Host[],
  resolveAlias: (raw: string) => string | undefined,
): Map<string, SshConfigImportNotice[]> {
  const problems = new Map<string, SshConfigImportNotice[]>();
  const addProblem = (
    owner: PlannedHost,
    code: 'MISSING_PROXY_JUMP' | 'PROXY_JUMP_CONFLICT' | 'PROXY_JUMP_CYCLE',
    message: string,
  ) => {
    const current = problems.get(owner.parsed.id) ?? [];
    if (!current.some((item) => item.code === code && item.message === message))
      current.push(notice(code, owner.parsed.line, message));
    problems.set(owner.parsed.id, current);
  };
  const desiredEdges = new Map<string, { target: string; owner: PlannedHost }>();
  const setEdge = (source: string, target: string, owner: PlannedHost) => {
    if (source === target) {
      addProblem(owner, 'PROXY_JUMP_CYCLE', `ProxyJump cycle detected at “${source}”`);
      return;
    }
    const previous = desiredEdges.get(source);
    if (previous && previous.target !== target) {
      const message = `ProxyJump “${source}” resolves to conflicting targets “${previous.target}” and “${target}”`;
      addProblem(previous.owner, 'PROXY_JUMP_CONFLICT', message);
      addProblem(owner, 'PROXY_JUMP_CONFLICT', message);
      return;
    }
    desiredEdges.set(source, { target, owner });
  };

  for (const owner of plans.values()) {
    let previousAlias: string | undefined;
    for (const rawJump of owner.parsed.proxyJumps) {
      const jumpAlias = resolveAlias(rawJump);
      if (!jumpAlias) {
        addProblem(
          owner,
          'MISSING_PROXY_JUMP',
          `ProxyJump “${rawJump}” for “${owner.parsed.name}” does not resolve to a preview or saved Host`,
        );
        previousAlias = undefined;
        break;
      }
      if (previousAlias) setEdge(jumpAlias, previousAlias, owner);
      previousAlias = jumpAlias;
    }
    if (previousAlias) setEdge(owner.parsed.name.toLocaleLowerCase(), previousAlias, owner);
  }

  const existingByAlias = new Map(
    existingHosts.map((host) => [host.name.toLocaleLowerCase(), host]),
  );
  const existingAliasById = new Map(
    existingHosts.map((host) => [host.id, host.name.toLocaleLowerCase()]),
  );
  for (const [source, edge] of desiredEdges) {
    const existing = plans.get(source)?.existing ?? existingByAlias.get(source);
    if (!existing) continue;
    const target = plans.get(edge.target)?.existing ?? existingByAlias.get(edge.target);
    if (!target || existing.jumpHostId !== target.id)
      addProblem(
        edge.owner,
        'PROXY_JUMP_CONFLICT',
        `Saved Host “${existing.name}” has a different ProxyJump and cannot be rebound by import`,
      );
  }
  for (const [alias, plan] of plans) {
    if (!plan.existing || desiredEdges.has(alias)) continue;
    if (plan.existing.jumpHostId)
      addProblem(
        plan,
        'PROXY_JUMP_CONFLICT',
        `Saved Host “${plan.existing.name}” has a ProxyJump that is absent from this import`,
      );
  }

  const next = (alias: string): string | null => {
    const desired = desiredEdges.get(alias);
    if (desired) return desired.target;
    const existing = plans.get(alias)?.existing ?? existingByAlias.get(alias);
    return existing?.jumpHostId ? (existingAliasById.get(existing.jumpHostId) ?? null) : null;
  };
  for (const [start, plan] of plans) {
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let current: string | null = start;
    while (current) {
      const cycleStart = seenAt.get(current);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart);
        const owners = new Set(
          cycle.flatMap((alias) => {
            const owner = desiredEdges.get(alias)?.owner;
            return owner ? [owner] : [];
          }),
        );
        if (!owners.size) owners.add(plan);
        for (const owner of owners)
          addProblem(
            owner,
            'PROXY_JUMP_CYCLE',
            `ProxyJump cycle detected through ${cycle.join(' → ')}`,
          );
        break;
      }
      seenAt.set(current, path.length);
      path.push(current);
      current = next(current);
    }
  }
  return problems;
}

function assertNoJumpCycle(plans: Map<string, PlannedHost>, existingHosts: Host[]): void {
  const existingByAlias = new Map(
    existingHosts.map((host) => [host.name.toLocaleLowerCase(), host]),
  );
  const existingAliasById = new Map(
    existingHosts.map((host) => [host.id, host.name.toLocaleLowerCase()]),
  );
  const state = new Map<string, 'visiting' | 'done'>();
  const next = (alias: string): string | null => {
    const plan = plans.get(alias);
    if (plan) return plan.desiredJumpAlias;
    const host = existingByAlias.get(alias);
    return host?.jumpHostId ? (existingAliasById.get(host.jumpHostId) ?? null) : null;
  };
  const visit = (alias: string) => {
    const current = state.get(alias);
    if (current === 'visiting')
      throw new ApplicationError('CONFLICT', `ProxyJump cycle detected at “${alias}”`, 409);
    if (current === 'done') return;
    state.set(alias, 'visiting');
    const target = next(alias);
    if (target) visit(target);
    state.set(alias, 'done');
  };
  for (const alias of plans.keys()) visit(alias);
}

function topologicalNewHosts(plans: Map<string, PlannedHost>): PlannedHost[] {
  const output: PlannedHost[] = [];
  const visited = new Set<string>();
  const visit = (alias: string) => {
    if (visited.has(alias)) return;
    const plan = plans.get(alias);
    if (!plan || plan.existing) return;
    if (plan.desiredJumpAlias) visit(plan.desiredJumpAlias);
    visited.add(alias);
    output.push(plan);
  };
  for (const alias of plans.keys()) visit(alias);
  return output;
}
