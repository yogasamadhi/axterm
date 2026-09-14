# ADR-011: Native web session Host capability

Status: Accepted  
Date: 2026-09-13

## Context

Electerm 5.5.0 renders Web Bookmarks with Electron `<webview>`, enables popups
and disables parts of Chromium's security model. It also handles HTTP Basic
authentication through business IPC. A normal browser iframe cannot reproduce
sites that deny framing or apply a Bookmark-specific user agent, while enabling
`webviewTag` would expose an Electron-owned browsing surface directly to Axterm's
Renderer and weaken the existing sandbox.

## Decision

Axterm keeps `webviewTag: false` and implements embedded Web Bookmarks as a
versioned Desktop Host capability backed by Electron `WebContentsView`. Runtime
owns the Bookmark and Web Session resources. It is the only caller of the
generation-authenticated `/host/v1/web-views` API. Renderer controls the session
through generated Runtime REST methods and reports only bounded presentation
geometry and visibility; it never receives an Electron object or a Host token.

The Host accepts only credential-free `http:` and `https:` URLs, clamps view
bounds to the owning window, applies the configured user agent and uses a
dedicated persistent Chromium partition. Node integration, webview tags and
insecure content stay disabled; context isolation, sandboxing and web security
stay enabled. Permission and download requests are denied. New-window requests
and unsafe navigation are blocked and reported in secret-free session metadata;
the user may explicitly open a validated blocked/current HTTP(S) URL through the
existing external-link capability.

HTTP Basic authentication is transient. Electron's login callback is owned by
the Host with a two-minute timeout. Runtime exposes only the challenge metadata;
Renderer submits an explicit response over REST, clears its form values, and no
username/password enters SQLite, Zustand, Query, browser storage or logs.

Each Runtime generation owns at most eight Web Sessions. Session close,
generation rotation, window close and Host shutdown remove the view, listeners,
pending authentication callback and timers deterministically. Inactive and
restored/disconnected tabs cannot leave an interactive native view over the app.

## Consequences

Web pages that reject iframe embedding work without enabling Renderer Electron
access. Native view geometry must track pane layout changes, and Playwright must
inspect both the Renderer controls and Electron's child WebContents. The Host
capability is unavailable in Headless mode; its typed Runtime resources remain
present and return a capability error when no Desktop Host is connected.

## Alternatives considered

- A sandboxed iframe was rejected because custom user-agent behavior and many
  real sites cannot be reproduced reliably.
- Electron `<webview>` was rejected because it requires `webviewTag`, exposes an
  Electron browsing primitive to Renderer and repeats Electerm's business IPC.
- Automatically allowing popups or opening them externally was rejected because
  it removes the user's explicit navigation decision.

## Migration / rollback

SQLite migration 24 adds one nullable Web Bookmark payload. Removing the feature
requires closing all Host views before removing Runtime routes; existing payloads
remain inert data until the migration is restored.
