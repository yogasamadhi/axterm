# Profile recovery

This private filesystem component is shared by the native shell and Profile runner.
It has no loader, Cordis, subprocess, network or business implementation dependency.
Architecture checks enforce this boundary, including literal/dynamic module imports.

`prepareProfileRecovery(home, profile)` requires an absolute home, acquires the same
runtime lock as startup/offline management, writes a recovery intent, then renames
the Profile patch to a unique backup. It preserves manifests, packages, data and
previous backups. A partially prepared or unreadable marker does not authorize normal
startup: `profileRecoveryActive` treats any existing marker as recovery and propagates
filesystem errors. Marker contents are never evaluated.

The runner owns trusted recovery composition and installation-only module resolution;
this component does not load a Profile. `clearProfileRecovery` requires explicit
confirmation and the runtime lock. It removes only the marker, never restores a
backup, and must run after the application stops and the user reviews configuration.
