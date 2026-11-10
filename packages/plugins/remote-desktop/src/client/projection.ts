import {
  remoteDesktopBaselineSchema,
  remoteDesktopDeltaSchema,
  type RemoteDesktopBaseline,
  type RemoteDesktopDelta,
} from '@axterm/plugin-api/remote-desktop';
/** Complete validated replacement is the only reconnect path; deltas cannot bridge generations or gaps. */
export class RemoteDesktopProjection {
  private current?: RemoteDesktopBaseline;
  replace(input: RemoteDesktopBaseline): RemoteDesktopBaseline {
    const baseline = remoteDesktopBaselineSchema.parse(input);
    if (new Set(baseline.sessions.map((session) => session.id)).size !== baseline.sessions.length)
      throw new Error('REMOTE_DESKTOP_DUPLICATE_SESSION');
    return (this.current = Object.freeze({
      ...baseline,
      sessions: Object.freeze(baseline.sessions.map((session) => Object.freeze(session))),
    }));
  }
  apply(input: RemoteDesktopDelta): RemoteDesktopBaseline {
    const delta = remoteDesktopDeltaSchema.parse(input);
    const current = this.current;
    if (
      !current ||
      delta.generation !== current.generation ||
      delta.revision !== current.revision + 1
    )
      throw new Error('REMOTE_DESKTOP_METADATA_REVISION_INVALID');
    if (delta.type === 'remove' && !current.sessions.some((session) => session.id === delta.id))
      throw new Error('REMOTE_DESKTOP_UNKNOWN_SESSION');
    const sessions =
      delta.type === 'remove'
        ? current.sessions.filter((session) => session.id !== delta.id)
        : current.sessions.some((session) => session.id === delta.session.id)
          ? current.sessions.map((session) =>
              session.id === delta.session.id ? delta.session : session,
            )
          : [...current.sessions, delta.session];
    return this.replace({ ...current, revision: delta.revision, sessions });
  }
}
