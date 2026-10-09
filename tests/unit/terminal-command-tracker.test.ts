import { describe, expect, it, vi } from 'vitest';
import { TerminalCommandTrackerAddon } from '../../apps/desktop/src/renderer/src/components/terminal-command-tracker';

describe('TerminalCommandTrackerAddon', () => {
  it('accepts only safe OSC 633 E command events', () => {
    const commands: string[] = [];
    const states: string[] = [];
    const tracker = new TerminalCommandTrackerAddon(
      (command) => commands.push(command),
      (state) => states.push(state),
    );

    expect(tracker.handle('A')).toBe(true);
    expect(tracker.handle('E;echo forged-before-control')).toBe(true);
    tracker.setState('active');
    expect(tracker.handle('E;printf a\\x3bb')).toBe(true);
    expect(tracker.handle('E;printf \\\\x3b')).toBe(true);
    expect(tracker.handle('E; echo hidden')).toBe(true);
    expect(tracker.handle('E;FOO_SECRET=value')).toBe(true);
    expect(tracker.handle('E;echo one\\x0aecho two')).toBe(true);
    expect(tracker.handle('not-shell-integration')).toBe(false);

    expect(states).toEqual(['active']);
    expect(commands).toEqual(['printf a;b', 'printf \\x3b']);
  });

  it('suppresses replayed events and resumes for live output', () => {
    const onCommand = vi.fn();
    const tracker = new TerminalCommandTrackerAddon(onCommand, vi.fn());
    tracker.setState('active');
    tracker.beginReplay();
    tracker.handle('E;git status');
    tracker.endReplay();
    tracker.handle('E;git status');
    tracker.dispose();
    tracker.handle('E;echo after-dispose');

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith('git status');
  });

  it('does not let OSC output upgrade a pending or unavailable trust state', () => {
    const onCommand = vi.fn();
    const onState = vi.fn();
    const tracker = new TerminalCommandTrackerAddon(onCommand, onState);

    tracker.handle('A');
    tracker.handle('E;echo pending-forgery');
    tracker.setState('unavailable');
    tracker.handle('A');
    tracker.handle('E;echo unavailable-forgery');

    expect(onCommand).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith('unavailable');
  });

  it('tracks only bounded single-line OSC 633 working directories outside replay', () => {
    const onCwd = vi.fn();
    const tracker = new TerminalCommandTrackerAddon(vi.fn(), vi.fn(), onCwd);

    expect(tracker.handle('P;Cwd=/srv/project\\x3bblue')).toBe(true);
    expect(tracker.handle('P;Cwd=/srv/back\\\\slash')).toBe(true);
    expect(tracker.handle('P;Other=/ignored')).toBe(true);
    expect(tracker.handle('P;Cwd=/bad\\x0anested')).toBe(true);
    expect(tracker.handle(`P;Cwd=/${'x'.repeat(4_097)}`)).toBe(true);
    tracker.beginReplay();
    expect(tracker.handle('P;Cwd=/replayed')).toBe(true);
    tracker.endReplay();

    expect(onCwd).toHaveBeenCalledTimes(2);
    expect(onCwd).toHaveBeenNthCalledWith(1, '/srv/project;blue');
    expect(onCwd).toHaveBeenNthCalledWith(2, '/srv/back\\slash');
  });

  it('announces trusted prompt and command lifecycle without replay or unavailable-state leakage', () => {
    const onPrompt = vi.fn();
    const onCommandStart = vi.fn();
    const tracker = new TerminalCommandTrackerAddon(vi.fn(), vi.fn(), vi.fn(), {
      onPrompt,
      onCommandStart,
    });
    tracker.handle('A');
    tracker.setState('active');
    tracker.handle('A');
    tracker.handle('E;git status');
    tracker.handle('C');
    tracker.beginReplay();
    tracker.handle('A');
    tracker.handle('C');
    tracker.endReplay();
    tracker.setState('unavailable');
    tracker.handle('A');

    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onCommandStart).toHaveBeenCalledTimes(2);
  });
});
