const $ = (id) => document.getElementById(id);
const el = (tag, text, attrs = {}) => {
  const node = document.createElement(tag);
  if (text !== null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  return node;
};
const notice = (message) => {
  $('notice').textContent = message;
};
async function api(path, body) {
  const response = await fetch('/creator/api/' + path, {
    credentials: 'same-origin',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Try again shortly.');
  return result;
}
function field(label, tag = 'input', attrs = {}) {
  const wrapper = el('label', label);
  const input = el(tag, null, attrs);
  wrapper.append(input);
  return { wrapper, input };
}
function check(label, checked = false) {
  const wrapper = el('label', null, { class: 'check' }),
    input = el('input', null, { type: 'checkbox' });
  input.checked = checked;
  wrapper.append(input, document.createTextNode(label));
  return { wrapper, input };
}
function button(label, fn) {
  const node = el('button', label, { type: 'button' });
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await fn();
    } catch (error) {
      notice(error.message);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}
let session,
  recordings = [],
  accounts = [],
  permissions = new Map();
function showRecording(source) {
  const article = el('article', null, { class: 'item' });
  article.append(
    el('h3', source.title),
    el(
      'p',
      `${(source.size / 1024 ** 3).toFixed(2)} GiB · ${source.status} · ${
        source.clips.length
      } clips`
    )
  );
  const details = el('details', null),
    summary = el('summary', 'Permission and creator credit');
  details.append(summary);
  const permissionForm = el('form', null),
    credit = field('Credit shown with every post', 'input', {
      required: '',
      maxlength: '500',
      placeholder: 'Video by @yourname. Shared with permission.',
    });
  const selected = ['youtube', 'tiktok', 'instagram', 'discord'].map(
    (platform) => ({
      platform,
      ...check(
        platform === 'youtube'
          ? 'YouTube'
          : platform[0].toUpperCase() + platform.slice(1)
      ),
    })
  );
  const confirm = check(
      'I own this recording or have written permission to share and edit it.'
    ),
    editing = check('OrderSMP may edit this recording into clips.'),
    monetization = check('OrderSMP may monetize these posts.');
  const savedPermission = permissions.get(source.id);
  if (savedPermission) {
    credit.input.value = savedPermission.credit;
    for (const item of selected)
      item.input.checked = savedPermission.platforms.includes(item.platform);
    confirm.input.checked = !savedPermission.revokedAt;
    editing.input.checked = savedPermission.editing;
    monetization.input.checked = savedPermission.monetization;
    details.append(
      el(
        'p',
        savedPermission.revokedAt
          ? 'Permission revoked.'
          : `Permission recorded. Credit: ${savedPermission.credit}`
      )
    );
  }
  permissionForm.append(
    credit.wrapper,
    ...selected.map((item) => item.wrapper),
    confirm.wrapper,
    editing.wrapper,
    monetization.wrapper
  );
  const save = el('button', 'Save permission', { type: 'submit' });
  permissionForm.append(save);
  permissionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await api(`sources/${source.id}/permission`, {
        credit: credit.input.value,
        platforms: selected
          .filter((item) => item.input.checked)
          .map((item) => item.platform),
        confirmed: confirm.input.checked,
        editing: editing.input.checked,
        monetization: monetization.input.checked,
      });
      notice('Permission saved. Credit will be added to each post.');
      await refresh();
    } catch (error) {
      notice(error.message);
    } finally {
      save.disabled = false;
    }
  });
  if (source.creatorId === session.id) {
    details.append(permissionForm);
    if (source.permissionId)
      details.append(
        button('Revoke permission', async () => {
          await api(`sources/${source.id}/revoke`, {});
          notice('Permission revoked. Queued posts will need a new review.');
          await refresh();
        })
      );
  } else
    details.append(el('p', 'The creator must record their own permission.'));
  article.append(details);
  const prepare = el('form', null),
    markers = field(
      'Clip ranges in seconds, 3 to 60 seconds long. One start,end range per line. Leave blank for suggestions or a short video in full.',
      'textarea',
      { placeholder: '45,75\n120,165', rows: '3' }
    ),
    language = field('Recording language', 'select');
  for (const [value, label] of [
    ['auto', 'Detect language'],
    ['en', 'English'],
    ['lv', 'Latvian'],
  ])
    language.input.append(el('option', label, { value }));
  const start = el('button', 'Prepare clips', { type: 'submit' });
  prepare.append(markers.wrapper, language.wrapper, start);
  prepare.addEventListener('submit', async (event) => {
    event.preventDefault();
    start.disabled = true;
    try {
      const ranges = markers.input.value.trim()
        ? markers.input.value
            .trim()
            .split('\n')
            .map((line) => {
              const [start, end, ...extra] = line.split(',').map(Number);
              if (
                extra.length ||
                !Number.isFinite(start) ||
                !Number.isFinite(end)
              )
                throw new Error('Use start,end for each clip range.');
              return { start, end };
            })
        : [];
      await api(`sources/${source.id}/prepare`, {
        markers: ranges,
        language: language.input.value,
      });
      notice('Recording queued. Refresh to see the preparation result.');
    } catch (error) {
      notice(error.message);
    } finally {
      start.disabled = false;
    }
  });
  article.append(
    prepare,
    button('Check preparation', async () => {
      const jobs = await api(`sources/${source.id}/jobs`);
      notice(
        jobs.length
          ? jobs
              .map((job) => `${job.status}${job.error ? ': ' + job.error : ''}`)
              .join(' · ')
          : 'No preparation jobs yet.'
      );
      await refresh();
    })
  );
  return article;
}
function showDraft(draft) {
  const article = el('article', null, { class: 'item' });
  article.append(el('h3', draft.title), el('p', `Status: ${draft.status}`));
  const source = recordings.find((item) => item.id === draft.sourceId),
    clip = source?.clips.find((item) => item.path === draft.media?.[0]?.path);
  if (clip) {
    const video = el('video', null, {
      controls: '',
      preload: 'metadata',
      src: `/creator/api/sources/${source.id}/media?clip=${clip.id}`,
    });
    article.append(video);
  }
  const title = field('Title', 'input', { required: '', maxlength: '100' }),
    description = field('Description', 'textarea', {
      required: '',
      maxlength: '4000',
    });
  title.input.value = draft.title;
  description.input.value = draft.description;
  title.input.disabled = description.input.disabled = draft.status !== 'draft';
  article.append(title.wrapper, description.wrapper);
  const permission = permissions.get(draft.sourceId);
  article.append(
    el(
      'p',
      permission && !permission.revokedAt
        ? `Creator credit: ${permission.credit}`
        : 'The creator must save permission before this clip can be scheduled.'
    )
  );
  if (draft.status === 'draft')
    article.append(
      button('Save draft', async () => {
        await api('publishing/update', {
          draftId: draft.id,
          version: draft.version,
          title: title.input.value,
          description: description.input.value,
        });
        notice('Draft saved.');
        await refresh();
      })
    );
  if (session.owner && draft.status === 'draft' && clip) {
    const review = el('details', null);
    review.append(el('summary', 'Review and schedule'));
    const form = el('form', null),
      time = field('Publish at (your local time)', 'input', {
        type: 'datetime-local',
        required: '',
      });
    const date = new Date(Date.now() + 3600000);
    time.input.value = new Date(
      date.getTime() - date.getTimezoneOffset() * 60000
    )
      .toISOString()
      .slice(0, 16);
    const destinations = [];
    for (const account of accounts) {
      const pick = check(
        `${account.name} · ${account.platform}${
          account.ready ? '' : ' · ' + (account.reason || 'unavailable')
        }`
      );
      pick.input.disabled = !account.ready;
      form.append(pick.wrapper);
      const item = { account, pick };
      if (account.platform === 'youtube') {
        item.visibility = field('YouTube visibility', 'select');
        for (const value of ['private', 'unlisted', 'public'])
          item.visibility.input.append(el('option', value, { value }));
        item.audience = field('YouTube: made for kids?', 'select');
        item.audience.input.append(
          el('option', 'Choose audience', { value: '' }),
          el('option', 'No', { value: 'no' }),
          el('option', 'Yes', { value: 'yes' })
        );
        form.append(item.visibility.wrapper, item.audience.wrapper);
      }
      if (account.platform === 'discord') {
        item.channel = field('Discord channel ID', 'input', {
          inputmode: 'numeric',
          placeholder: 'Channel ID',
        });
        form.append(item.channel.wrapper);
      }
      destinations.push(item);
    }
    const reviewed = check(
      'I watched this exact clip and checked the context, description, credit, audience and destinations.'
    );
    form.append(time.wrapper, reviewed.wrapper);
    const submit = el('button', 'Approve schedule', { type: 'submit' });
    form.append(submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        if (
          title.input.value !== draft.title ||
          description.input.value !== draft.description
        )
          throw new Error('Save your draft changes before reviewing it.');
        await api('publishing/approve', {
          draftId: draft.id,
          version: draft.version,
          rightsConfirmed: reviewed.input.checked,
          dueAt: new Date(time.input.value).toISOString(),
          destinations: destinations
            .filter((item) => item.pick.input.checked)
            .map((item) => ({
              accountId: item.account.id,
              platform: item.account.platform,
              settings:
                item.account.platform === 'youtube'
                  ? {
                      title: draft.title,
                      type: item.visibility.input.value,
                      selfDeclaredMadeForKids: item.audience.input.value,
                      tags: [],
                    }
                  : item.account.platform === 'discord'
                  ? { channel: item.channel.input.value }
                  : { post_type: 'post' },
            })),
        });
        notice(
          'Schedule approved. Permission and the video checksum will be checked again at dispatch.'
        );
        await refresh();
      } catch (error) {
        notice(error.message);
      } finally {
        submit.disabled = false;
      }
    });
    review.append(form);
    article.append(review);
  }
  return article;
}
async function refresh() {
  try {
    session = await api('session');
    $('session').textContent = `Signed in as ${session.email}${
      session.owner ? ' · Channel owner' : ''
    }`;
    recordings = await api('sources');
    permissions = new Map(
      await Promise.all(
        recordings
          .filter((item) => item.permissionId)
          .map(async (source) => [
            source.id,
            await api(`sources/${source.id}/permission`),
          ])
      )
    );
    $('recordings').replaceChildren(
      ...(recordings.length
        ? recordings.map(showRecording)
        : [el('p', 'Your recordings will appear here.')])
    );
    try {
      accounts = await api('publishing/integrations');
    } catch (error) {
      accounts = [];
      notice(error.message);
    }
    const drafts = await api('publishing/drafts');
    $('drafts').replaceChildren(
      ...(drafts.length
        ? drafts.map(showDraft)
        : [el('p', 'Prepare a recording to create clip drafts.')])
    );
    $('calendar-section').hidden = !session.owner;
    if (session.owner) {
      const deliveries = await api('publishing/calendar');
      $('calendar').replaceChildren(
        ...(deliveries.length
          ? deliveries.map((item) => {
              const row = el('article', null, { class: 'item' });
              row.append(
                el('h3', new Date(item.dueAt).toLocaleString()),
                el(
                  'p',
                  `${item.platform} · ${item.status.replaceAll('_', ' ')}`
                )
              );
              if (item.note) row.append(el('p', item.note));
              if (
                [
                  'scheduled',
                  'blocked',
                  'failed_review',
                  'missed_review',
                ].includes(item.status)
              )
                row.append(
                  button(
                    item.status === 'scheduled'
                      ? 'Cancel schedule'
                      : 'Return to draft',
                    async () => {
                      await api('publishing/cancel', { draftId: item.draftId });
                      notice(
                        item.status === 'scheduled'
                          ? 'Schedule cancelled.'
                          : 'The clip is back in drafts. Review it again before scheduling.'
                      );
                      await refresh();
                    }
                  )
                );
              if (
                ['uncertain', 'processing', 'cancel_review'].includes(
                  item.status
                )
              )
                row.append(
                  el(
                    'p',
                    'The owner must check the platform result before trying this post again.'
                  )
                );
              return row;
            })
          : [el('p', 'No publishing schedules yet.')])
      );
    }
  } catch (error) {
    notice(error.message);
  }
}
$('refresh').addEventListener('click', refresh);
$('upload').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    file = form.elements.file.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 ** 3)
    return notice('Choose a video smaller than 20 GiB.');
  const submit = form.querySelector('button'),
    xhr = new XMLHttpRequest();
  submit.disabled = true;
  $('progress').hidden = false;
  xhr.open(
    'POST',
    '/creator/api/sources?name=' + encodeURIComponent(form.elements.title.value)
  );
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable)
      $('progress').value = (event.loaded / event.total) * 100;
  };
  xhr.onload = async () => {
    submit.disabled = false;
    $('progress').hidden = true;
    try {
      const result = JSON.parse(xhr.responseText);
      if (xhr.status !== 201) throw new Error(result.error || 'Upload failed.');
      notice('Recording uploaded. Add permission, then prepare clips.');
      form.reset();
      await refresh();
    } catch (error) {
      notice(error.message);
    }
  };
  xhr.onerror = () => {
    submit.disabled = false;
    $('progress').hidden = true;
    notice('The connection stopped. Try the upload again.');
  };
  xhr.send(file);
});
await refresh();
