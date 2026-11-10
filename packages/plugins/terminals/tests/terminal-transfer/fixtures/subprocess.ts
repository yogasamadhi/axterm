import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@axterm/infra-subprocess-local';
import { beforeEach, afterEach } from 'vitest';
import { NodePtyAdapter as OwnedPtyAdapter } from '../../../src/adapters/node-pty-adapter.ts';
let root: Context;
beforeEach(async () => {
  root = new Context();
  await root.plugin(LocalSubprocessRuntime);
});
afterEach(async () => {
  await root?.fiber.dispose();
});
/** Real PTYs use the same owned Cordis service and deterministic drain as the Host. */
export class NodePtyAdapter extends OwnedPtyAdapter {
  constructor() {
    super(root.subprocess);
  }
}
