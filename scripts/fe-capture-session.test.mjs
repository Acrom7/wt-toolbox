import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { FECaptureSession } from '../src/utils/FECaptureSession.js';

test('capture cleanup, stop errors and delayed navigation preserve session ownership', async (t) => {
  const previousWorker = globalThis.Worker;
  const previousChrome = globalThis.chrome;
  const commands = [];
  let abortGate;
  let stopError;
  let rejectStop = false;
  let workers = 0;
  let listener;
  let stateGate;
  let pageState = {};
  let onPull;

  globalThis.Worker = class {
    constructor() {
      workers++;
    }
    postMessage({ id, command }) {
      commands.push(command);
      const value =
        command.method === 'start' || command.method === 'ingest'
          ? { id: command.sessionId, count: 0, bytes: 0, startedAt: 1 }
          : command.method === 'sessions'
            ? []
            : undefined;

      globalThis.queueMicrotask(() => this.onmessage?.({ data: { id, value } }));
    }
    terminate() {}
  };
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (value) => {
          listener = value;
        },
      },
      async sendMessage({ payload: { documentId, request } }) {
        const pull = request.method === 'pull' ? onPull?.(request.ack) : undefined;

        if (request.method === 'state' && stateGate) {
          await stateGate;

          return { ok: false, error: 'old capture closed' };
        }

        if (rejectStop && request.method === 'stop') {
          throw new Error('stop failed');
        }

        if (request.method === 'abort' && abortGate) {
          await abortGate;
        }

        return {
          ok: true,
          documentId: documentId ?? 'new-document',
          data: {
            version: 2,
            value: pull ?? { session: {} },
            state: {
              recording: true,
              error: request.method === 'stop' ? stopError : undefined,
              ...pageState,
            },
          },
        };
      },
    },
  };

  try {
    await t.test(
      'direct waiting status follows the page and clears when recording stops',
      async () => {
        await import('../src/feHistory.js');
        const request = (method) =>
          new Promise((resolve) =>
            listener(
              { type: 'fe-history', payload: { tabId: 1, request: { method, token: 'direct' } } },
              {},
              resolve,
            ),
          );

        try {
          await request('connect');
          pageState = { waitingForDirect: true };
          assert.equal((await request('start')).data.state.waitingForDirect, true);
          pageState = {};
          await new Promise((resolve) => {
            onPull = resolve;
          });
          await nextTurn();
          assert.equal((await request('state')).data.state.waitingForDirect, false);
          await request('stop');
          pageState.waitingForDirect = true;
          assert.equal((await request('start')).data.state.waitingForDirect, true);
          assert.equal((await request('stop')).data.state.waitingForDirect, false);
        } finally {
          onPull = undefined;
          pageState = {};
          await request('close');
          commands.length = 0;
        }
      },
    );
    await t.test('new start waits for the old asynchronous failure cleanup', async () => {
      const viewer = new FECaptureSession(1, 'owner');
      let release;

      abortGate = new Promise((resolve) => {
        release = resolve;
      });
      viewer.session = { id: 'old' };
      viewer.documentId = 'old-document';
      viewer.recording = true;
      const failing = viewer.fail('navigation');
      const restarting = viewer.begin();

      try {
        await nextTurn();
        assert.equal(commands.filter((command) => command.method === 'start').length, 0);
        release();
        await failing;
        abortGate = undefined;
        await restarting;
        assert.equal(viewer.recording, true);
        assert.equal(viewer.documentId, 'new-document');
        assert(
          !commands.some(
            (command) => command.method === 'stop' && command.sessionId === viewer.session.id,
          ),
        );
      } finally {
        release();
        abortGate = undefined;
        await Promise.allSettled([failing, restarting]);
        await viewer.close();
      }
    });
    await t.test(
      'navigation for the already attached document preserves reload capture',
      async () => {
        const viewer = new FECaptureSession(1, 'owner');

        viewer.session = { id: 'reloaded' };
        viewer.documentId = 'new-document';
        viewer.recording = true;
        try {
          await viewer.navigate('new-document');
          assert.equal(viewer.recording, true);
          assert.equal(viewer.error, undefined);
        } finally {
          await viewer.close();
        }
      },
    );
    await t.test(
      'manual stop persists the capture error returned after its final drain',
      async () => {
        const viewer = new FECaptureSession(1, 'owner');

        viewer.session = { id: 'stop-error' };
        viewer.recording = true;
        stopError = 'capture budget exceeded';
        try {
          await viewer.stop();
          assert(
            commands.some(
              (command) =>
                command.method === 'stop' &&
                command.sessionId === 'stop-error' &&
                command.error === stopError,
            ),
          );
        } finally {
          stopError = undefined;
          await viewer.close();
        }
      },
    );
    await t.test('reload reports an early failure of its own session immediately', async () => {
      const viewer = new FECaptureSession(1, 'owner');
      const sessionId = 'reload-overflow';
      const error = 'Превышен лимит раннего буфера FE';

      viewer.session = { id: sessionId };
      viewer.recording = true;
      viewer.reloading = true;
      pageState = { sessionId, recording: false, error };
      const pumping = viewer.pump();

      try {
        await nextTurn();
        assert.equal(viewer.error, error);
        assert(
          commands.some(
            (item) =>
              item.method === 'stop' && item.sessionId === sessionId && item.error === error,
          ),
        );
      } finally {
        viewer.recording = false;
        await pumping;
        pageState = {};
        await viewer.close();
      }
    });
    await t.test(
      'reload drains accepted records before reporting an error from the page',
      async () => {
        const viewer = new FECaptureSession(1, 'owner');
        const session = { id: 'reload-drain' };
        const error = 'Захват остановлен при переполнении';
        const chunk = { id: 1, from: 0, end: 2, text: '[]', done: true };
        const acknowledgements = [];

        viewer.session = session;
        viewer.recording = true;
        viewer.reloading = true;
        pageState = { sessionId: session.id, recording: true, error };
        onPull = (ack) => {
          acknowledgements.push(ack);
          if (ack) {
            pageState.recording = false;

            return {};
          }

          return { chunk };
        };
        try {
          await viewer.pump();
          assert(
            commands.some(
              (item) =>
                item.method === 'ingest' &&
                item.sessionId === session.id &&
                item.json === chunk.text,
            ),
          );
          assert.deepEqual(acknowledgements, [undefined, { id: 1, offset: 2 }]);
          assert.match(viewer.error, /Захват остановлен при переполнении/);
        } finally {
          onPull = undefined;
          pageState = {};
          await viewer.close();
        }
      },
    );
    await t.test(
      'a failed close removes the old worker so reconnect can read history',
      async () => {
        await import('../src/feHistory.js');
        const request = (method) =>
          new Promise((resolve) =>
            listener(
              {
                type: 'fe-history',
                payload: { tabId: 1, origin: 'test', request: { method, token: 'close-error' } },
              },
              {},
              resolve,
            ),
          );

        await request('connect');
        await request('start');
        const before = workers;

        rejectStop = true;
        try {
          assert.equal((await request('close')).ok, false);
          rejectStop = false;
          assert.equal((await request('connect')).ok, true);
          assert.equal(workers, before + 1);
        } finally {
          rejectStop = false;
          await request('close');
        }
      },
    );
    await t.test(
      'late heartbeat error cannot stop a new session in the same document',
      async () => {
        const viewer = new FECaptureSession(1, 'owner');
        const originalTimeout = globalThis.setTimeout;
        let tick;
        let release;

        viewer.session = { id: 'before-heartbeat' };
        viewer.recording = true;
        viewer.documentId = 'new-document';
        stateGate = new Promise((resolve) => {
          release = resolve;
        });
        globalThis.setTimeout = (callback) => {
          tick = callback;
        };
        try {
          viewer.keepAlive();
        } finally {
          globalThis.setTimeout = originalTimeout;
        }

        const heartbeat = tick();

        try {
          await viewer.stop();
          await viewer.begin();
          release();
          await heartbeat;
          assert.equal(viewer.recording, true);
          assert(
            !commands.some(
              (command) => command.method === 'stop' && command.sessionId === viewer.session.id,
            ),
          );
        } finally {
          release();
          stateGate = undefined;
          await heartbeat;
          await viewer.close();
        }
      },
    );
  } finally {
    globalThis.Worker = previousWorker;
    globalThis.chrome = previousChrome;
  }
});
