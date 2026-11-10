import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ManagedFileImportModel } from '../../packages/plugins/files/src/client/imports.ts';
function reply(generation: string) {
  return Response.json(
    {
      grantId: 'grant_' + randomUUID(),
      kind: 'file',
      name: 'file.txt',
      permissions: ['read'],
      createdAt: new Date().toISOString(),
    },
    { headers: { 'x-axterm-generation': generation } },
  );
}
it('owns accepted requests through a late response, cancels its body, and joins the same close during reentrant cancellation', async () => {
  const response = Promise.withResolvers<Response>();
  const generation = randomUUID();
  let signal: AbortSignal | undefined;
  let reentrant: Promise<void> | undefined;
  let calls = 0;
  const model = new ManagedFileImportModel(
    () => generation,
    async (_input, init) => {
      calls++;
      signal = init.signal!;
      signal.addEventListener(
        'abort',
        () => {
          reentrant = model.dispose();
        },
        { once: true },
      );
      return response.promise;
    },
  );
  const importing = expect(
    model.import(new File(['value'], 'file.txt'), false),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await setImmediate();
  expect(calls).toBe(1);
  let drained = false;
  const close = model.dispose();
  void close.then(() => {
    drained = true;
  });
  expect(reentrant).toBe(close);
  expect(signal!.aborted).toBe(true);
  await setImmediate();
  expect(drained).toBe(false);
  let canceled = false;
  response.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { 'x-axterm-generation': generation } },
    ),
  );
  await importing;
  await close;
  expect(canceled).toBe(true);
  expect(model.resourceCount()).toBe(0);
  expect(model.dispose()).toBe(close);
});
it('never replays after a generation replacement or network failure and bounds metadata before decoding', async () => {
  let generation = randomUUID();
  let calls = 0;
  const response = Promise.withResolvers<Response>();
  const model = new ManagedFileImportModel(
    () => generation,
    async () => {
      calls++;
      return response.promise;
    },
  );
  try {
    const old = generation;
    const importing = expect(
      model.import(new File(['value'], 'file.txt'), false),
    ).rejects.toMatchObject({ code: 'files/failure', details: { reason: 'stale' } });
    await setImmediate();
    generation = randomUUID();
    response.resolve(reply(old));
    await importing;
    expect(calls).toBe(1);
  } finally {
    await model.dispose();
  }
  const huge = new ManagedFileImportModel(
    () => generation,
    async () => new Response('x'.repeat(65537), { headers: { 'x-axterm-generation': generation } }),
  );
  try {
    await expect(huge.import(new File(['value'], 'file.txt'), false)).rejects.toThrow(
      'RESPONSE_CAPACITY',
    );
  } finally {
    await huge.dispose();
  }
});
it('bounds admission and cancels accepted queued work before any request starts', async () => {
  let calls = 0;
  const generation = randomUUID();
  const model = new ManagedFileImportModel(
    () => generation,
    async () => {
      calls++;
      return reply(generation);
    },
  );
  const accepted = Array.from({ length: 8 }, () =>
    model.import(new File(['value'], 'file.txt'), false),
  );
  const rejected = accepted.map((task) =>
    expect(task).rejects.toMatchObject({ name: 'AbortError' }),
  );
  expect(() => model.import(new File(['value'], 'file.txt'), false)).toThrow('CAPACITY');
  await model.dispose();
  await Promise.all(rejected);
  expect(calls).toBe(0);
  expect(model.resourceCount()).toBe(0);
  expect(() => model.import(new File(['value'], 'file.txt'), false)).toThrow('MODEL_CLOSED');
});

it('submits a zero-byte import without an empty Blob transport while retaining its exact declaration', async () => {
  const generation = randomUUID();
  let request: RequestInit | undefined;
  const model = new ManagedFileImportModel(
    () => generation,
    async (_path, init) => {
      request = init;
      return reply(generation);
    },
  );
  try {
    const result = await model.import(new File([], 'file.txt'), false);
    expect(result.name).toBe('file.txt');
    expect(request?.body).toBeUndefined();
    expect(new Headers(request?.headers).get('x-axterm-file-size')).toBe('0');
  } finally {
    await model.dispose();
  }
});
