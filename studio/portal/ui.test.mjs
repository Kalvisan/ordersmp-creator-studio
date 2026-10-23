import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createWorkspace } from './ui.mjs';

const until = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('The workspace action did not finish');
};
async function setup(t, owner = true) {
  const dom = new JSDOM(
    await readFile(new URL('./ui.html', import.meta.url), 'utf8'),
    { url: 'https://studio.example.com/creator/', pretendToBeVisual: true }
  );
  t.after(() => dom.window.close());
  const { window } = dom,
    calls = [];
  window.matchMedia = () => ({ matches: false });
  for (const method of ['load', 'pause'])
    window.HTMLMediaElement.prototype[method] = () => {};
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const fixture = {
    source: {
      id: 'source-id',
      creatorId: 'actor-id',
      title: '<img src=x onerror=alert(1)>',
      size: 5000000,
      status: 'ready',
      permissionId: 'permission-id',
      clips: [{ id: 'clip-id', path: 'renders/clip.mp4' }],
    },
    permission: {
      id: 'permission-id',
      version: 1,
      creatorHandle: '@b1oeorblue',
      credit: 'Video by the creator.',
      platforms: ['youtube'],
      editing: true,
      monetization: false,
      revokedAt: null,
    },
    draft: {
      id: 'draft-id',
      version: 1,
      creatorId: 'actor-id',
      sourceId: 'source-id',
      title: 'A Minecraft clip',
      description: 'The clip description.',
      media: [{ path: 'renders/clip.mp4' }],
      status: 'draft',
    },
    jobs: [],
    jobError: false,
  };
  window.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.body) {
      const body = JSON.parse(options.body);
      if (url.endsWith('/permission')) {
        fixture.permission = {
          ...fixture.permission,
          ...body,
          version: fixture.permission.version + 1,
        };
        return Response.json(fixture.permission);
      }
      if (url.endsWith('/prepare')) {
        fixture.jobs = [
          { id: 'job-id', status: 'queued', createdAt: '2026-11-01T00:00:00Z' },
        ];
        return Response.json(fixture.jobs[0]);
      }
      if (url.endsWith('/publishing/update')) {
        fixture.draft = {
          ...fixture.draft,
          title: body.title,
          description: body.description,
          version: fixture.draft.version + 1,
        };
        return Response.json(fixture.draft);
      }
      if (url.endsWith('/publishing/cancel'))
        return Response.json({ ok: true });
      assert.fail(`Unexpected workspace write: ${url}`);
    }
    if (url.endsWith('/jobs') && fixture.jobError)
      return Response.json(
        { error: 'Job status unavailable' },
        { status: 503 }
      );
    const routes = {
      '/creator/api/session': {
        id: 'actor-id',
        email: 'actor@example.com',
        owner,
        role: 'SUPERADMIN',
      },
      '/creator/api/sources': [fixture.source],
      '/creator/api/sources/source-id/permission': fixture.permission,
      '/creator/api/sources/source-id/jobs': fixture.jobs,
      '/creator/api/publishing/drafts': [fixture.draft],
      '/creator/api/publishing/integrations': [
        {
          id: 'youtube-id',
          name: 'Official YouTube',
          platform: 'youtube',
          ready: true,
        },
      ],
      '/creator/api/publishing/calendar': [
        'blocked',
        'failed_review',
        'missed_review',
        'uncertain',
        'processing',
        'cancel_review',
      ].map((status, index) => ({
        draftId: `calendar-${index}`,
        dueAt: '2026-11-01T12:00:00Z',
        platform: 'youtube',
        status,
      })),
    };
    assert.ok(
      Object.hasOwn(routes, url),
      `Unexpected workspace endpoint: ${url}`
    );
    return Response.json(routes[url]);
  };
  const workspace = createWorkspace(window.document, window);
  await workspace.start();
  const $ = (id) => window.document.getElementById(id);
  const button = (text) =>
    [...window.document.querySelectorAll('button')].find(
      (node) => node.textContent === text
    );
  const enter = (node, value) => {
    node.value = value;
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return { window, calls, fixture, workspace, $, button, enter };
}

test('creator credit validates real handle characters under the browser Unicode-sets pattern rules', async (t) => {
  const { window } = await setup(t);
  const handle = [...window.document.querySelectorAll('label')]
    .find((node) => node.textContent === 'Creator credit')
    .querySelector('input');
  assert.doesNotThrow(() => new RegExp(handle.pattern, 'v'));
  for (const value of ['@b1oeorblue', '@creator-name', '@creator.name', '@Creator_1']) {
    handle.value = value;
    assert.equal(handle.checkValidity(), true, value);
  }
  for (const value of ['creator', '@', '@bad handle', '@a/b', '@' + 'a'.repeat(41)]) {
    handle.value = value;
    assert.equal(handle.checkValidity(), false, value);
  }
});

test('actual visual workspace preserves caption edits, uses existing publishing contracts and keeps unsafe credit unapproved', async (t) => {
  const app = await setup(t),
    { window, calls, workspace, $, button, enter } = app;
  assert.equal(window.document.querySelectorAll('[onerror]').length, 0);
  assert.ok(
    window.document.body.textContent.includes('<img src=x onerror=alert(1)>')
  );
  assert.equal(window.document.querySelectorAll('video').length, 1);
  assert.equal($('notice').textContent, '');
  const handle = [...window.document.querySelectorAll('label')]
    .find((node) => node.textContent === 'Creator credit')
    .querySelector('input');
  assert.equal(handle.value, '@b1oeorblue');
  window.document.querySelector('.draft-tile').click();
  await until(() => Boolean(button('Review publishing schedule')));
  const caption = [...window.document.querySelectorAll('label')]
    .find((node) => node.textContent === 'Caption')
    .querySelector('textarea');
  enter(caption, 'Keep these unsaved words.');
  await workspace.refresh();
  assert.equal(
    [...window.document.querySelectorAll('textarea')][0].value,
    'Keep these unsaved words.'
  );
  button('Save draft').click();
  await until(
    () =>
      calls.some((call) => call.url.endsWith('/publishing/update')) &&
      !workspace.state.busy
  );
  assert.deepEqual(
    JSON.parse(
      calls.find((call) => call.url.endsWith('/publishing/update')).options.body
    ),
    {
      draftId: 'draft-id',
      version: 1,
      title: 'A Minecraft clip',
      description: 'Keep these unsaved words.',
    }
  );
  button('Review publishing schedule').click();
  await until(() => $('publishing-dialog').open);
  assert.ok(
    $('owner-review').textContent.includes('Prepare this recording again')
  );
  assert.equal(Boolean(button('Approve schedule')), false);
  const returns = [...window.document.querySelectorAll('button')].filter(
    (node) => node.textContent === 'Return to draft'
  );
  assert.equal(returns.length, 3);
  assert.equal(window.document.querySelectorAll('#calendar article').length, 6);
  assert.equal(
    [...window.document.querySelectorAll('#calendar article')].filter((row) =>
      row.textContent.includes('platform result')
    ).length,
    3
  );
  returns[0].click();
  await until(() =>
    calls.some((call) => call.url.endsWith('/publishing/cancel')) &&
    !returns[0].disabled && !workspace.state.refreshing
  );
  assert.deepEqual(
    JSON.parse(
      calls.find((call) => call.url.endsWith('/publishing/cancel')).options.body
    ),
    { draftId: 'calendar-0' }
  );
  assert.equal(
    calls.some((call) => call.url.endsWith('/publishing/approve')),
    false
  );
});

test('creator choices remain explicit, preparation uses exact trim and fresh revocation cannot be silently regranted', async (t) => {
  const { window, calls, fixture, workspace, $, button, enter } = await setup(
    t,
    false
  );
  assert.equal($('native-workspace').hidden, true);
  assert.equal($('queue-open').hidden, true);
  assert.equal(
    calls.some((call) => /publishing\/(integrations|calendar)/.test(call.url)),
    false
  );
  const handle = [...window.document.querySelectorAll('label')]
    .find((node) => node.textContent === 'Creator credit')
    .querySelector('input');
  enter(handle, '@NewCreator');
  enter($('trim-start'), '2.5');
  enter($('trim-end'), '8.2');
  button('Select all platforms').click();
  button('Create draft').click();
  await until(
    () =>
      calls.some((call) => call.url.endsWith('/prepare')) &&
      !workspace.state.busy
  );
  const permission = JSON.parse(
    calls.find((call) => call.url.endsWith('/permission') && call.options.body)
      .options.body
  );
  assert.equal(permission.creatorHandle, '@NewCreator');
  assert.equal(permission.confirmed, true);
  assert.equal(permission.editing, true);
  assert.equal(permission.monetization, false);
  assert.equal(permission.platforms.length, 4);
  assert.deepEqual(
    JSON.parse(
      calls.find((call) => call.url.endsWith('/prepare')).options.body
    ),
    {
      creatorHandle: '@NewCreator',
      markers: [{ start: 2.5, end: 8.2 }],
      language: 'auto',
    }
  );
  fixture.jobs = [];
  fixture.permission = {
    ...fixture.permission,
    revokedAt: '2026-11-01T01:00:00Z',
    version: fixture.permission.version + 1,
  };
  await workspace.refresh();
  const confirmation = [...window.document.querySelectorAll('label')]
    .find(
      (node) =>
        node.textContent ===
        'I own this recording or have permission to share and edit it.'
    )
    .querySelector('input');
  assert.equal(confirmation.checked, false);
  const writeCount = calls.filter((call) => call.options.body).length;
  button('Create draft').click();
  await until(() => !workspace.state.busy);
  assert.equal(calls.filter((call) => call.options.body).length, writeCount);
});

test('job polling pauses when hidden, stops at sixty checks and backs off after three failures', async (t) => {
  const { window, fixture, calls, workspace } = await setup(t);
  fixture.jobs = [
    { id: 'queued-id', status: 'queued', createdAt: '2026-11-01T00:00:00Z' },
  ];
  await workspace.refresh();
  Object.defineProperty(window.document, 'hidden', {
    value: true,
    configurable: true,
  });
  const before = calls.length;
  await workspace.poll();
  assert.equal(calls.length, before);
  Object.defineProperty(window.document, 'hidden', {
    value: false,
    configurable: true,
  });
  workspace.state.polls = 59;
  await workspace.poll();
  assert.equal(workspace.state.polls, 60);
  const capped = calls.length;
  await workspace.poll();
  assert.equal(calls.length, capped);
  workspace.state.polls = 0;
  fixture.jobError = true;
  await workspace.poll();
  await workspace.poll();
  await workspace.poll();
  assert.equal(workspace.state.pollErrors, 3);
  const failed = calls.length;
  await workspace.poll();
  assert.equal(calls.length, failed);
});
