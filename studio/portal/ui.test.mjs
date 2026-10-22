import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('the actual portal UI renders recorded permission safely and saves through the publishing contract', async () => {
  const html = await readFile(new URL('./ui.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('./ui.mjs', import.meta.url), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://studio.example.com/creator/',
  });
  const { window } = dom;
  const calls = [];
  const recording = {
    id: 'source-id',
    creatorId: 'owner-id',
    title: '<img src=x onerror=alert(1)>',
    size: 5000000,
    status: 'ready',
    permissionId: 'permission-id',
    clips: [{ id: 'clip-id', path: 'renders/clip.mp4' }],
  };
  window.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const routes = {
      '/creator/api/session': {
        id: 'owner-id',
        email: 'owner@example.com',
        owner: true,
        role: 'SUPERADMIN',
      },
      '/creator/api/sources': [recording],
      '/creator/api/sources/source-id/permission': {
        credit: 'Video by the creator.',
        creatorHandle: '@b1oeorblue',
        platforms: ['youtube'],
        editing: true,
        monetization: false,
        revokedAt: null,
      },
      '/creator/api/publishing/integrations': [
        {
          id: 'youtube-id',
          name: 'Official YouTube',
          platform: 'youtube',
          ready: true,
        },
      ],
      '/creator/api/publishing/drafts': [
        {
          id: 'draft-id',
          version: 1,
          sourceId: 'source-id',
          title: 'A Minecraft clip',
          description: 'The clip description.',
          media: [{ path: 'renders/clip.mp4' }],
          status: 'draft',
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
      '/creator/api/publishing/update': { ok: true },
      '/creator/api/publishing/cancel': { ok: true },
      '/creator/api/sources/source-id/prepare': { id: 'job-id' },
    };
    assert.ok(Object.hasOwn(routes, url), `Unexpected UI endpoint: ${url}`);
    return Response.json(routes[url]);
  };
  await window.eval(`(async () => { ${source}\n })()`);
  assert.ok(window.document.body.textContent.includes('Video by the creator.'));
  assert.equal(window.document.querySelectorAll('[onerror]').length, 0);
  assert.equal(window.document.querySelectorAll('video').length, 1);
  assert.equal(window.document.getElementById('notice').textContent, '');
  const creditLabels = [...window.document.querySelectorAll('label')].filter(label => label.textContent === 'On-screen credit');
  assert.equal(creditLabels.length, 1);
  const handleInput = creditLabels[0].querySelector('input');
  assert.equal(handleInput.value, '@b1oeorblue');
  assert.equal(handleInput.getAttribute('pattern'), '@[A-Za-z0-9_.-]{1,40}');
  handleInput.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(JSON.parse(calls.find(call => call.url.endsWith('/permission') && call.options.body).options.body).creatorHandle, '@b1oeorblue');
  const prepare = [...window.document.querySelectorAll('button')].find(button => button.textContent === 'Prepare clips');
  prepare.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(JSON.parse(calls.find(call => call.url.endsWith('/prepare')).options.body).creatorHandle, '@b1oeorblue');
  assert.ok(window.document.body.textContent.includes('Prepare this recording again with the current on-screen credit'));
  assert.equal([...window.document.querySelectorAll('button')].some(button => button.textContent === 'Approve schedule'), false);
  const returns = [...window.document.querySelectorAll('button')].filter(
    (button) => button.textContent === 'Return to draft'
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
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    JSON.parse(
      calls.find((call) => call.url === '/creator/api/publishing/cancel')
        .options.body
    ),
    { draftId: 'calendar-0' }
  );
  const save = [...window.document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Save draft'
  );
  assert.ok(save);
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const update = calls.find(
    (call) => call.url === '/creator/api/publishing/update'
  );
  assert.ok(update);
  assert.deepEqual(JSON.parse(update.options.body), {
    draftId: 'draft-id',
    version: 1,
    title: 'A Minecraft clip',
    description: 'The clip description.',
  });
  dom.window.close();
});
