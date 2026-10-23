export function recordingTitle(filename) {
  return (
    String(filename)
      .replace(/\.(mp4|mov|mkv)$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim()
      .slice(0, 180) || 'Untitled recording'
  );
}
export function clipRanges(text, start, end, duration) {
  const ranges = text.trim()
    ? text
        .trim()
        .split('\n')
        .map((line) => {
          const values = line.split(',');
          if (values.length !== 2 || values.some((value) => !value.trim()))
            throw new Error('Use start,end for each clip range.');
          return { start: Number(values[0]), end: Number(values[1]) };
        })
    : [{ start: Number(start), end: Number(end) }];
  if (
    (!text.trim() && (start === '' || end === '')) ||
    ranges.length > 10 ||
    ranges.some(
      (range) =>
        !Number.isFinite(range.start) ||
        !Number.isFinite(range.end) ||
        range.start < 0 ||
        range.end > 43200 ||
        range.end - range.start < 3 ||
        range.end - range.start > 60 ||
        (Number.isFinite(duration) && range.end > duration + 0.1)
    )
  )
    throw new Error(
      'Choose up to 10 ranges, each 3 to 60 seconds, within the recording.'
    );
  return ranges;
}
export function timeLabel(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  return `${Math.floor(seconds / 60)}:${String(
    Math.floor(seconds % 60)
  ).padStart(2, '0')}`;
}

export function createWorkspace(document, window) {
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    if (text !== null) node.textContent = text;
    for (const [key, value] of Object.entries(attrs))
      node.setAttribute(key, value);
    return node;
  };
  const state = {
    session: null,
    recordings: [],
    drafts: [],
    accounts: [],
    permissions: new Map(),
    jobs: new Map(),
    edits: new Map(),
    captions: new Map(),
    trims: new Map(),
    selected: null,
    pending: null,
    busy: false,
    refreshing: false,
    previewKey: null,
    playingRange: false,
    polls: 0,
    pollErrors: 0,
    polling: false,
    timer: null,
  };
  let permissionForm, sourceControls, pendingTitle, focusReturn;
  const source = () =>
    state.recordings.find(
      (item) => item.id === (selectedDraft()?.sourceId || state.selected?.id)
    );
  const selectedDraft = () =>
    state.selected?.kind === 'draft'
      ? state.drafts.find((item) => item.id === state.selected.id)
      : null;
  const activePermission = (item) => item && !item.revokedAt && item.editing;
  const trim = () => {
    const key = state.selected?.kind === 'pending' ? 'pending' : source()?.id;
    if (!state.trims.has(key))
      state.trims.set(key, {
        start: '',
        end: '',
        duration: NaN,
        language: 'auto',
        ranges: '',
        mode: 'trim',
      });
    return state.trims.get(key);
  };
  function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').hidden = !message;
    $('notice').classList.toggle('error-copy', error);
  }
  async function api(path, body) {
    const response = await window.fetch('/creator/api/' + path, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Try again shortly.');
    return result;
  }
  function action(label, fn, className = '') {
    const node = el('button', label, { type: 'button', class: className });
    node.addEventListener('click', async () => {
      node.disabled = true;
      try {
        await fn();
      } catch (error) {
        notice(error.message, true);
      } finally {
        node.disabled = false;
      }
    });
    return node;
  }
  function field(label, tag = 'input', attrs = {}) {
    const wrapper = el('label', label, { class: 'field' }),
      input = el(tag, null, attrs);
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
  function closePanels() {
    for (const id of ['library', 'inspector']) {
      $(id + '-panel').classList.remove('open');
      $(id + '-open').setAttribute('aria-expanded', 'false');
    }
    $('drawer-backdrop').hidden = true;
    if (focusReturn?.isConnected) focusReturn.focus();
  }
  function openPanel(name) {
    closePanels();
    focusReturn = document.activeElement;
    $(name + '-panel').classList.add('open');
    $(name + '-open').setAttribute('aria-expanded', 'true');
    $('drawer-backdrop').hidden = false;
    $(name + '-panel')
      .querySelector('button, input, summary')
      ?.focus();
  }
  function stages() {
    const item = source(),
      permission = state.permissions.get(item?.id);
    const completed = [
      Boolean(item),
      Boolean(activePermission(permission)),
      Boolean(item?.clips?.length),
      state.drafts.some((draft) => draft.sourceId === item?.id),
    ];
    const current =
      state.selected?.kind === 'draft'
        ? 3
        : Math.min(
            completed.findIndex((value) => !value) < 0
              ? 3
              : completed.findIndex((value) => !value),
            3
          );
    [...$('stages').children].forEach((node, index) => {
      node.dataset.complete = String(completed[index]);
      if (index === current) node.setAttribute('aria-current', 'step');
      else node.removeAttribute('aria-current');
    });
  }
  function latestJob(item) {
    return state.jobs.get(item?.id)?.[0];
  }
  function statusLabel(item) {
    const job = latestJob(item);
    return job?.status === 'processing'
      ? 'Preparing'
      : job?.status === 'queued'
      ? 'Queued'
      : item.clips?.length
      ? 'Clips ready'
      : 'Uploaded';
  }
  function renderLibrary() {
    const rows = state.recordings.map((item) => {
      const node = action('', () => select('source', item.id), 'media-item');
      node.setAttribute(
        'aria-pressed',
        String(
          state.selected?.kind === 'source' && state.selected.id === item.id
        )
      );
      const words = el('span', null);
      words.append(
        el('strong', item.title),
        el(
          'small',
          `${(item.size / 1024 ** 2).toFixed(1)} MiB · ${statusLabel(item)}`
        )
      );
      node.append(
        el('span', '▷', { class: 'file-icon', 'aria-hidden': 'true' }),
        words
      );
      return node;
    });
    if (state.pending) {
      const row = action('', () => select('pending', 'pending'), 'media-item');
      row.setAttribute(
        'aria-pressed',
        String(state.selected?.kind === 'pending')
      );
      const words = el('span', null);
      words.append(
        el('strong', state.pending.title),
        el('small', 'Local file · Ready to upload')
      );
      row.append(
        el('span', '+', { class: 'file-icon', 'aria-hidden': 'true' }),
        words
      );
      rows.unshift(row);
    }
    $('recordings').replaceChildren(
      ...(rows.length
        ? rows
        : [el('p', 'Import a recording to begin.', { class: 'empty-copy' })])
    );
    $('draft-count').textContent = String(state.drafts.length);
    $('drafts').replaceChildren(
      ...(state.drafts.length
        ? state.drafts.map((draft) => {
            const node = action(
              '',
              () => select('draft', draft.id),
              'draft-tile'
            );
            node.setAttribute(
              'aria-pressed',
              String(
                state.selected?.kind === 'draft' &&
                  state.selected.id === draft.id
              )
            );
            node.append(
              el('span', '▷', { class: 'clip-symbol', 'aria-hidden': 'true' }),
              el('strong', draft.title),
              el(
                'small',
                draft.status === 'draft'
                  ? 'Draft · Not published'
                  : draft.status.replaceAll('_', ' ')
              )
            );
            return node;
          })
        : [
            el(
              'p',
              'Prepared clips appear here. Every clip starts as a draft.',
              { class: 'empty-copy' }
            ),
          ])
    );
  }
  function renderTrim() {
    const item = trim();
    $('trim-start').value = item.start;
    $('trim-end').value = item.end;
    for (const [id, value] of [
      ['start-range', item.start],
      ['end-range', item.end],
    ]) {
      $(id).disabled = !Number.isFinite(item.duration);
      $(id).max = Number.isFinite(item.duration) ? String(item.duration) : '60';
      $(id).value = String(value || 0);
    }
    let error = '';
    try {
      if (item.mode === 'trim')
        clipRanges(item.ranges, item.start, item.end, item.duration);
    } catch (issue) {
      error = issue.message;
    }
    $('trim-error').textContent =
      item.mode === 'suggestions'
        ? 'Suggestions use sound levels. Review the result before sharing.'
        : error || 'Choose 3 to 60 seconds.';
    $('trim-error').classList.toggle(
      'error-copy',
      Boolean(error && item.start !== '' && item.end !== '')
    );
    const length = Number(item.end) - Number(item.start);
    $('range-length').textContent =
      item.start !== '' && item.end !== '' && Number.isFinite(length)
        ? `${length.toFixed(1)}s selected`
        : '';
  }
  function renderPreview() {
    const item = source(),
      draft = selectedDraft(),
      pending = state.selected?.kind === 'pending' ? state.pending : null;
    const clip = item?.clips?.find(
      (value) => value.path === draft?.media?.[0]?.path
    );
    const url =
      pending?.url ||
      (item && (!draft || clip)
        ? `/creator/api/sources/${encodeURIComponent(item.id)}/media${
            clip ? '?clip=' + encodeURIComponent(clip.id) : ''
          }`
        : '');
    $('selected-title').textContent =
      draft?.title ||
      pending?.title ||
      item?.title ||
      'Your next clip starts here';
    $('preview').hidden = !url;
    $('empty-preview').hidden = Boolean(url);
    $('trim-panel').hidden = !item || Boolean(draft);
    if (state.previewKey !== url) {
      state.playingRange = false;
      state.previewKey = url;
      $('preview-error').hidden = true;
      $('preview').pause();
      if (url) {
        $('preview').src = url;
        $('preview').load();
      } else {
        $('preview').removeAttribute('src');
        $('preview').load();
      }
    }
    renderTrim();
    stages();
    updatePrimary();
  }
  function permissionValues(item) {
    if (!state.edits.has(item.id)) {
      const saved = state.permissions.get(item.id),
        active = activePermission(saved);
      state.edits.set(item.id, {
        creatorHandle: saved?.creatorHandle || '',
        credit: saved?.credit || '',
        platforms: active ? [...saved.platforms] : [],
        confirmed: Boolean(active),
        editing: Boolean(active),
        monetization: active ? saved.monetization : false,
      });
    }
    return state.edits.get(item.id);
  }
  function sourceInspector(item) {
    const values = permissionValues(item),
      editable = item.creatorId === state.session.id;
    const form = el('form', null),
      handle = field('Creator credit', 'input', {
        required: '',
        maxlength: '41',
        pattern: '@[A-Za-z0-9_.-]{1,40}',
        placeholder: '@creator',
        autocomplete: 'off',
      });
    handle.input.value = values.creatorHandle;
    handle.input.disabled = !editable;
    const creditNote = el('p', 'Shown on the clip and in each post.', {
      class: 'permission-note',
    });
    const platforms = el('fieldset', null),
      choices = el('div', null, { class: 'platforms' });
    platforms.append(el('legend', 'Allowed platforms'));
    const checks = ['youtube', 'tiktok', 'instagram', 'discord'].map(
      (platform) => {
        const pick = check(
          platform === 'youtube'
            ? 'YouTube'
            : platform === 'tiktok'
            ? 'TikTok'
            : platform[0].toUpperCase() + platform.slice(1),
          values.platforms.includes(platform)
        );
        pick.input.disabled = !editable;
        pick.input.addEventListener('change', () => {
          values.platforms = checks
            .filter((choice) => choice.pick.input.checked)
            .map((choice) => choice.platform);
        });
        choices.append(pick.wrapper);
        return { platform, pick };
      }
    );
    const all = action(
      'Select all platforms',
      () => {
        checks.forEach((choice) => {
          choice.pick.input.checked = true;
        });
        values.platforms = checks.map((choice) => choice.platform);
      },
      'quiet'
    );
    all.disabled = !editable;
    platforms.append(choices, all);
    const confirm = check(
      'I own this recording or have permission to share and edit it.',
      values.confirmed
    );
    confirm.input.required = true;
    confirm.input.disabled = !editable;
    confirm.input.addEventListener('change', () => {
      values.confirmed = confirm.input.checked;
      values.editing = confirm.input.checked;
    });
    const advanced = el('details', null),
      body = el('div', null, { class: 'advanced' });
    advanced.append(el('summary', 'Advanced'), body);
    const credit = field('Credit line in each post', 'input', {
      maxlength: '500',
    });
    credit.input.value = values.credit;
    credit.input.disabled = !editable;
    credit.input.addEventListener('input', () => {
      values.credit = credit.input.value;
    });
    handle.input.addEventListener('input', () => {
      const old = values.creatorHandle;
      values.creatorHandle = handle.input.value;
      if (
        !values.credit ||
        values.credit === `Video by ${old}. Shared with permission.`
      ) {
        values.credit = `Video by ${values.creatorHandle.trim()}. Shared with permission.`;
        credit.input.value = values.credit;
      }
      const prior = state.permissions.get(item.id)?.creatorHandle;
      creditNote.textContent =
        prior && prior !== values.creatorHandle.trim() && item.clips.length
          ? 'A new credit needs a new render. Existing clips keep their original on-screen credit.'
          : 'Shown on the clip and in each post.';
    });
    const money = check(
      'OrderSMP may monetize these posts.',
      values.monetization
    );
    money.input.disabled = !editable;
    money.input.addEventListener('change', () => {
      values.monetization = money.input.checked;
    });
    const mode = field('Clip selection', 'select');
    mode.input.append(
      el('option', 'Selected range', { value: 'trim' }),
      el('option', 'Suggest clips from sound levels', { value: 'suggestions' })
    );
    mode.input.value = trim().mode;
    mode.input.addEventListener('change', () => {
      trim().mode = mode.input.value;
      renderTrim();
    });
    const language = field('Recording language', 'select');
    for (const [value, label] of [
      ['auto', 'Detect language'],
      ['en', 'English'],
      ['lv', 'Latvian'],
    ])
      language.input.append(el('option', label, { value }));
    language.input.value = trim().language;
    language.input.addEventListener('change', () => {
      trim().language = language.input.value;
    });
    const ranges = field('More ranges (start,end in seconds)', 'textarea', {
      rows: '2',
      placeholder: '45,75\n120,165',
    });
    ranges.input.value = trim().ranges;
    ranges.input.addEventListener('input', () => {
      trim().ranges = ranges.input.value;
      renderTrim();
    });
    body.append(
      credit.wrapper,
      money.wrapper,
      mode.wrapper,
      language.wrapper,
      ranges.wrapper,
      el(
        'p',
        'Up to 10 ranges, each 3 to 60 seconds. Suggestions use sound levels. Transcription depends on the server speech model.',
        { class: 'hint' }
      )
    );
    if (editable && item.permissionId)
      body.append(
        action(
          'Revoke permission',
          async () => {
            await api(`sources/${item.id}/revoke`, {});
            state.edits.delete(item.id);
            state.permissions.delete(item.id);
            notice('Permission revoked. Queued posts need a new review.');
            await refresh();
          },
          'quiet'
        )
      );
    if (!editable)
      form.append(
        el(
          'p',
          'The creator records permission. You can prepare clips once their permission is active.',
          { class: 'hint' }
        )
      );
    form.append(
      handle.wrapper,
      creditNote,
      platforms,
      confirm.wrapper,
      el(
        'p',
        'OrderSMP makes clips for the platforms you choose. Creating a draft does not publish it.',
        { class: 'permission-note' }
      ),
      advanced
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      primaryAction();
    });
    permissionForm = form;
    sourceControls = { handle, confirm, checks, values };
    return form;
  }
  function draftInspector(draft) {
    if (!state.captions.has(draft.id))
      state.captions.set(draft.id, {
        title: draft.title,
        description: draft.description,
        baseVersion: draft.version,
      });
    const edit = state.captions.get(draft.id),
      form = el('form', null),
      title = field('Clip title', 'input', { required: '', maxlength: '100' }),
      description = field('Caption', 'textarea', {
        maxlength: '4000',
        rows: '7',
      });
    title.input.value = edit.title;
    description.input.value = edit.description;
    title.input.disabled = description.input.disabled =
      draft.status !== 'draft';
    const dirty = el('p', '', { class: 'dirty', role: 'status' });
    const mark = () => {
      edit.title = title.input.value;
      edit.description = description.input.value;
      dirty.textContent =
        edit.title !== draft.title || edit.description !== draft.description
          ? 'Unsaved changes'
          : 'Saved';
    };
    title.input.addEventListener('input', mark);
    description.input.addEventListener('input', mark);
    mark();
    const permission = state.permissions.get(draft.sourceId);
    form.append(
      el('p', 'Draft · Owner review is required before publishing.', {
        class: 'section-caption',
      }),
      title.wrapper,
      description.wrapper,
      dirty,
      el(
        'p',
        activePermission(permission)
          ? `Credit: ${permission.credit}`
          : 'The creator must record active permission.',
        { class: 'permission-note' }
      )
    );
    const settings = el('details', null);
    settings.append(el('summary', 'Advanced'));
    const body = el('div', null, { class: 'advanced' });
    body.append(
      el(
        'p',
        `On-screen credit: ${
          draft.media?.[0]?.creatorHandle || 'Missing. Prepare this clip again.'
        }`,
        { class: 'hint' }
      ),
      action(
        'Edit recording permission',
        () => select('source', draft.sourceId),
        'quiet'
      )
    );
    settings.append(body);
    form.append(settings);
    if (state.session.owner && draft.status === 'draft')
      form.append(
        action(
          'Review publishing schedule',
          () => openPublishing(draft),
          'quiet'
        )
      );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      primaryAction();
    });
    permissionForm = form;
    return form;
  }
  function renderInspector() {
    permissionForm = null;
    sourceControls = null;
    const item = source(),
      draft = selectedDraft();
    if (state.selected?.kind === 'pending' && state.pending) {
      pendingTitle = field('Recording title', 'input', {
        required: '',
        maxlength: '180',
      });
      pendingTitle.input.value = state.pending.title;
      pendingTitle.input.addEventListener('input', () => {
        state.pending.title = pendingTitle.input.value;
        $('selected-title').textContent =
          pendingTitle.input.value || 'Untitled recording';
      });
      $('inspector').replaceChildren(
        el('p', 'Local preview · Not uploaded yet', {
          class: 'section-caption',
        }),
        pendingTitle.wrapper,
        el(
          'p',
          `${(state.pending.file.size / 1024 ** 2).toFixed(
            1
          )} MiB. Keep this tab open during upload.`,
          { class: 'hint' }
        ),
        action('Choose a different file', () => $('file').click(), 'quiet')
      );
    } else if (draft) $('inspector').replaceChildren(draftInspector(draft));
    else if (item)
      $('inspector').replaceChildren(
        el('p', 'Prepare a clip draft', { class: 'section-caption' }),
        sourceInspector(item)
      );
    else
      $('inspector').replaceChildren(
        el('p', 'Choose a recording to see its details.', {
          class: 'empty-copy',
        })
      );
  }
  function updatePrimary() {
    const draft = selectedDraft(),
      item = source(),
      job = latestJob(item),
      pending = state.selected?.kind === 'pending';
    $('primary-action').textContent = state.busy
      ? pending
        ? 'Uploading...'
        : draft
        ? 'Saving...'
        : 'Queuing...'
      : pending
      ? 'Upload recording'
      : draft
      ? 'Save draft'
      : item
      ? 'Create draft'
      : 'Import a recording';
    $('primary-action').disabled =
      state.busy ||
      (!item && !pending) ||
      (draft && draft.status !== 'draft') ||
      (!draft && ['queued', 'processing'].includes(job?.status));
    $('job-status').textContent = pending
      ? 'Preview locally. Upload when you are ready.'
      : draft
      ? 'Edit your caption. Publishing stays with the channel owner.'
      : job?.status === 'queued'
      ? 'Queued · Waiting for a worker.'
      : job?.status === 'processing'
      ? 'Preparing clips · Your source stays private.'
      : job?.status === 'failed'
      ? `Preparation stopped: ${
          job.error || 'Check the recording and try again.'
        }`
      : item
      ? 'Create a private draft from your selected moment.'
      : 'Your recordings stay private until an owner approves a post.';
  }
  async function select(kind, id) {
    state.selected = { kind, id };
    closePanels();
    const item = source();
    if (item) {
      const selection = state.selected;
      if (item.permissionId) {
        const previous = state.permissions.get(item.id),
          current = await api(`sources/${item.id}/permission`);
        if (
          previous &&
          (previous.version !== current?.version ||
            previous.revokedAt !== current?.revokedAt)
        )
          state.edits.delete(item.id);
        state.permissions.set(item.id, current);
      }
      state.jobs.set(
        item.id,
        (await api(`sources/${item.id}/jobs`)).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt)
        )
      );
      if (state.selected !== selection) return;
    }
    renderLibrary();
    renderInspector();
    renderPreview();
  }
  async function refresh({ manual = false } = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    $('refresh').disabled = true;
    if (manual) {
      state.polls = 0;
      state.pollErrors = 0;
    }
    try {
      if (!state.session) state.session = await api('session');
      $('session').textContent = state.session.owner
        ? 'Channel owner'
        : 'Creator';
      $('native-workspace').hidden = $('queue-open').hidden =
        !state.session.owner;
      const [recordings, drafts] = await Promise.all([
        api('sources'),
        api('publishing/drafts'),
      ]);
      state.recordings = recordings;
      state.drafts = drafts;
      if (
        state.selected?.kind === 'draft' &&
        !drafts.some((item) => item.id === state.selected.id)
      )
        state.selected = null;
      if (
        state.selected?.kind === 'source' &&
        !recordings.some((item) => item.id === state.selected.id)
      )
        state.selected = null;
      if (!state.selected && recordings.length)
        state.selected = { kind: 'source', id: recordings[0].id };
      if (state.selected) await select(state.selected.kind, state.selected.id);
      else {
        renderLibrary();
        renderInspector();
        renderPreview();
      }
    } catch (error) {
      state.pollErrors++;
      notice(error.message, true);
    } finally {
      state.refreshing = false;
      $('refresh').disabled = false;
    }
  }
  function chooseFile(file) {
    if (!file) return;
    if (state.busy)
      return notice('Wait for the current action to finish.', true);
    if (
      !/\.(mp4|mov|mkv)$/i.test(file.name) ||
      !file.size ||
      file.size > 90 * 1024 ** 2
    )
      return notice('Choose an MP4, MOV or MKV video up to 90 MiB.', true);
    if (state.pending) window.URL.revokeObjectURL(state.pending.url);
    state.pending = {
      file,
      title: recordingTitle(file.name),
      url: window.URL.createObjectURL(file),
    };
    state.trims.delete('pending');
    notice('');
    select('pending', 'pending');
  }
  async function upload() {
    if (showInvalid(pendingTitle.input)) return;
    const pending = state.pending;
    $('upload-status').hidden = false;
    $('progress').value = 0;
    $('upload-label').textContent = 'Uploading...';
    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new window.XMLHttpRequest();
        xhr.open(
          'POST',
          '/creator/api/sources?name=' + encodeURIComponent(pending.title)
        );
        xhr.setRequestHeader(
          'Content-Type',
          pending.file.type || 'application/octet-stream'
        );
        xhr.timeout = 6 * 3600000;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const value = (event.loaded / event.total) * 100;
            $('progress').value = value;
            $('upload-label').textContent = `Uploading · ${Math.round(value)}%`;
          }
        };
        xhr.onload = () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (xhr.status !== 201)
              throw new Error(data.error || 'Upload failed.');
            resolve(data);
          } catch (error) {
            reject(error);
          }
        };
        xhr.onerror = xhr.ontimeout = () =>
          reject(
            new Error(
              'The upload stopped. Check your connection and try again.'
            )
          );
        xhr.onabort = () => reject(new Error('The upload was cancelled.'));
        xhr.send(pending.file);
      });
      state.recordings.unshift(result);
      state.selected = { kind: 'source', id: result.id };
      state.pending = null;
      window.URL.revokeObjectURL(pending.url);
      $('file').value = '';
      notice(
        'Recording uploaded. Add creator credit and permission, then create a draft.'
      );
      await select('source', result.id);
      if (window.matchMedia('(max-width: 850px)').matches)
        openPanel('inspector');
    } finally {
      $('upload-status').hidden = true;
    }
  }
  async function prepare() {
    const item = source(),
      edit = permissionValues(item),
      current = state.permissions.get(item.id),
      selection = trim();
    const markers =
      selection.mode === 'suggestions'
        ? []
        : clipRanges(
            selection.ranges,
            selection.start,
            selection.end,
            selection.duration
          );
    let handle = current?.creatorHandle;
    if (item.creatorId === state.session.id) {
      if (showInvalid(permissionForm)) return;
      if (!edit.platforms.length) {
        openPanel('inspector');
        throw new Error('Choose the platforms you have permission to use.');
      }
      if (!edit.confirmed || !edit.editing) {
        openPanel('inspector');
        throw new Error('Confirm permission to share and edit this recording.');
      }
      handle = edit.creatorHandle.trim();
      const values = {
        ...edit,
        creatorHandle: handle,
        credit:
          edit.credit.trim() || `Video by ${handle}. Shared with permission.`,
      };
      const same =
        activePermission(current) &&
        current.creatorHandle === values.creatorHandle &&
        current.credit === values.credit &&
        current.monetization === values.monetization &&
        [...current.platforms].sort().join() ===
          [...values.platforms].sort().join();
      if (!same) {
        const saved = await api(`sources/${item.id}/permission`, values);
        state.permissions.set(item.id, saved);
        item.permissionId = saved.id;
      }
    } else if (!activePermission(current))
      throw new Error(
        'The creator must record permission before preparing clips.'
      );
    const job = await api(`sources/${item.id}/prepare`, {
      creatorHandle: handle,
      markers,
      language: selection.language,
    });
    state.jobs.set(item.id, [job]);
    state.polls = 0;
    state.pollErrors = 0;
    notice(
      'Queued for preparation. The result will appear as a private draft.'
    );
    renderLibrary();
    stages();
  }
  async function saveDraft() {
    const draft = selectedDraft(),
      edit = state.captions.get(draft.id);
    if (showInvalid(permissionForm)) return;
    const result = await api('publishing/update', {
      draftId: draft.id,
      version: edit.baseVersion,
      title: edit.title,
      description: edit.description,
    });
    state.captions.delete(draft.id);
    state.drafts = state.drafts.map((item) =>
      item.id === draft.id ? result : item
    );
    notice('Draft saved.');
    await refresh();
  }
  async function primaryAction() {
    if (state.busy) return;
    state.busy = true;
    updatePrimary();
    try {
      if (state.selected?.kind === 'pending') await upload();
      else if (selectedDraft()) await saveDraft();
      else if (source()) await prepare();
    } catch (error) {
      notice(error.message, true);
    } finally {
      state.busy = false;
      updatePrimary();
    }
  }
  function showInvalid(control) {
    if (control.checkValidity()) return false;
    if (window.matchMedia('(max-width: 850px)').matches) openPanel('inspector');
    control.reportValidity();
    return true;
  }
  function reviewForm(draft) {
    const item = state.recordings.find((value) => value.id === draft.sourceId),
      permission = state.permissions.get(draft.sourceId),
      clip = item?.clips.find((value) => value.path === draft.media?.[0]?.path);
    const section = el('section', null);
    if (
      !clip ||
      !activePermission(permission) ||
      !draft.media.every(
        (media) => media.creatorHandle === permission.creatorHandle
      )
    ) {
      section.append(
        el(
          'p',
          'Prepare this recording again with active permission and the current creator credit.',
          { class: 'hint' }
        )
      );
      return section;
    }
    const edit = state.captions.get(draft.id);
    if (
      edit &&
      (edit.title !== draft.title || edit.description !== draft.description)
    ) {
      section.append(
        el('p', 'Save caption changes before reviewing this draft.', {
          class: 'hint',
        })
      );
      return section;
    }
    section.append(
      el('h3', draft.title),
      el('video', null, {
        controls: '',
        playsinline: '',
        preload: 'metadata',
        src: `/creator/api/sources/${item.id}/media?clip=${clip.id}`,
      }),
      el('p', draft.description),
      el('p', `Credit: ${permission.credit}`, { class: 'hint' })
    );
    const form = el('form', null),
      destinations = [],
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
    for (const account of state.accounts) {
      const pick = check(
        `${account.name} · ${account.platform}${
          account.ready ? '' : ' · ' + (account.reason || 'Unavailable')
        }`
      );
      pick.input.disabled = !account.ready;
      form.append(pick.wrapper);
      const destination = { account, pick };
      if (account.platform === 'youtube') {
        destination.visibility = field('YouTube visibility', 'select');
        for (const value of ['private', 'unlisted', 'public'])
          destination.visibility.input.append(el('option', value, { value }));
        destination.audience = field('YouTube: made for kids?', 'select');
        for (const [value, label] of [
          ['', 'Choose audience'],
          ['no', 'No'],
          ['yes', 'Yes'],
        ])
          destination.audience.input.append(el('option', label, { value }));
        form.append(
          destination.visibility.wrapper,
          destination.audience.wrapper
        );
      }
      if (account.platform === 'discord') {
        destination.channel = field('Discord channel ID', 'input', {
          inputmode: 'numeric',
          placeholder: 'Channel ID',
        });
        form.append(destination.channel.wrapper);
      }
      destinations.push(destination);
    }
    const reviewed = check(
      'I watched this exact clip and checked the context, description, credit, audience and destinations.'
    );
    reviewed.input.required = true;
    const submit = el('button', 'Approve schedule', {
      type: 'submit',
      class: 'primary',
    });
    form.append(time.wrapper, reviewed.wrapper, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await api('publishing/approve', {
          draftId: draft.id,
          version: draft.version,
          rightsConfirmed: reviewed.input.checked,
          dueAt: new Date(time.input.value).toISOString(),
          destinations: destinations
            .filter((value) => value.pick.input.checked)
            .map((value) => ({
              accountId: value.account.id,
              platform: value.account.platform,
              settings:
                value.account.platform === 'youtube'
                  ? {
                      title: draft.title,
                      type: value.visibility.input.value,
                      selfDeclaredMadeForKids: value.audience.input.value,
                      tags: [],
                    }
                  : value.account.platform === 'discord'
                  ? { channel: value.channel.input.value }
                  : { post_type: 'post' },
            })),
        });
        notice(
          'Schedule approved. Permission and media will be checked again at dispatch.'
        );
        $('publishing-dialog').close();
        await refresh();
      } catch (error) {
        notice(error.message, true);
      } finally {
        submit.disabled = false;
      }
    });
    section.append(form);
    return section;
  }
  async function openPublishing(draft) {
    if (!state.session?.owner) return;
    try {
      state.accounts = await api('publishing/integrations');
    } catch (error) {
      state.accounts = [];
      notice(error.message, true);
    }
    const deliveries = await api('publishing/calendar');
    $('owner-review').replaceChildren(...(draft ? [reviewForm(draft)] : []));
    $('calendar').replaceChildren(
      ...(deliveries.length
        ? deliveries.map((item) => {
            const row = el('article', null, { class: 'queue-item' });
            row.append(
              el(
                'strong',
                `${item.platform} · ${item.status.replaceAll('_', ' ')}`
              ),
              el('p', new Date(item.dueAt).toLocaleString())
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
                action(
                  item.status === 'scheduled'
                    ? 'Cancel schedule'
                    : 'Return to draft',
                  async () => {
                    await api('publishing/cancel', { draftId: item.draftId });
                    notice(
                      'Schedule returned to draft. Review it again before publishing.'
                    );
                    await openPublishing();
                    await refresh();
                  }
                )
              );
            if (
              ['uncertain', 'processing', 'cancel_review'].includes(item.status)
            )
              row.append(
                el(
                  'p',
                  'Check the platform result before trying this post again.',
                  { class: 'hint' }
                )
              );
            return row;
          })
        : [el('p', 'No publishing schedules yet.', { class: 'hint' })])
    );
    if (!$('publishing-dialog').open) $('publishing-dialog').showModal();
  }
  async function poll() {
    if (
      document.hidden ||
      state.polling ||
      state.refreshing ||
      state.busy ||
      state.polls >= 60 ||
      state.pollErrors >= 3
    )
      return;
    const active = [...state.jobs.entries()].filter(([, jobs]) =>
      ['queued', 'processing'].includes(jobs[0]?.status)
    );
    if (!active.length) return;
    state.polling = true;
    state.polls++;
    try {
      let complete = false;
      for (const [id] of active) {
        const jobs = (await api(`sources/${id}/jobs`)).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt)
        );
        state.jobs.set(id, jobs);
        if (!['queued', 'processing'].includes(jobs[0]?.status))
          complete = true;
      }
      state.pollErrors = 0;
      renderLibrary();
      updatePrimary();
      if (complete) {
        notice('Preparation updated. Select a clip draft to review it.');
        await refresh();
      }
      if (state.polls >= 60)
        notice('Automatic updates paused. Refresh to check preparation.');
    } catch (error) {
      state.pollErrors++;
      if (state.pollErrors >= 3)
        notice('Updates paused. Refresh to check preparation.', true);
    } finally {
      state.polling = false;
    }
  }
  function bind() {
    $('import').addEventListener('click', () => $('file').click());
    $('empty-import').addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', () => chooseFile($('file').files[0]));
    const drop = $('drop-zone');
    for (const type of ['dragenter', 'dragover'])
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add('dragging');
      });
    for (const type of ['dragleave', 'drop'])
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.remove('dragging');
      });
    drop.addEventListener('drop', (event) =>
      chooseFile(event.dataTransfer.files[0])
    );
    $('primary-action').addEventListener('click', primaryAction);
    $('refresh').addEventListener('click', () => refresh({ manual: true }));
    $('library-open').addEventListener('click', () => openPanel('library'));
    $('inspector-open').addEventListener('click', () => openPanel('inspector'));
    document
      .querySelectorAll('[data-close-panel]')
      .forEach((node) => node.addEventListener('click', closePanels));
    $('drawer-backdrop').addEventListener('click', closePanels);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closePanels();
      const panel = document.querySelector('.panel.open');
      if (
        event.key === 'Tab' &&
        panel &&
        window.matchMedia('(max-width: 850px)').matches
      ) {
        const stops = [
          ...panel.querySelectorAll(
            'button, input, textarea, select, summary, a[href]'
          ),
        ].filter((node) => !node.disabled && node.getClientRects().length);
        if (event.shiftKey && document.activeElement === stops[0]) {
          event.preventDefault();
          stops.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === stops.at(-1)) {
          event.preventDefault();
          stops[0]?.focus();
        }
      }
    });
    $('queue-open').addEventListener('click', () =>
      openPublishing().catch((error) => notice(error.message, true))
    );
    $('queue-close').addEventListener('click', () =>
      $('publishing-dialog').close()
    );
    $('preview').addEventListener('loadedmetadata', () => {
      const video = $('preview'),
        value = trim();
      if (
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        !selectedDraft()
      ) {
        value.duration = video.duration;
        if (value.start === '') value.start = 0;
        if (value.end === '')
          value.end = Math.round(Math.min(30, video.duration) * 10) / 10;
        renderTrim();
      }
      $('playhead').textContent = `${timeLabel(
        video.currentTime
      )} / ${timeLabel(video.duration)}`;
    });
    $('preview').addEventListener('timeupdate', () => {
      const video = $('preview');
      $('playhead').textContent = `${timeLabel(
        video.currentTime
      )} / ${timeLabel(video.duration)}`;
      if (state.playingRange && video.currentTime >= Number(trim().end)) {
        video.pause();
        state.playingRange = false;
      }
    });
    $('preview').addEventListener('error', () => {
      if (!state.previewKey) return;
      $('preview-error').textContent =
        'This browser cannot preview this video. You can still choose a range in seconds and prepare clips.';
      $('preview-error').hidden = false;
    });
    for (const [id, key] of [
      ['trim-start', 'start'],
      ['trim-end', 'end'],
      ['start-range', 'start'],
      ['end-range', 'end'],
    ])
      $(id).addEventListener('input', () => {
        trim()[key] = $(id).value;
        state.playingRange = false;
        renderTrim();
      });
    $('set-in').addEventListener('click', () => {
      trim().start = Math.round($('preview').currentTime * 10) / 10;
      renderTrim();
    });
    $('set-out').addEventListener('click', () => {
      trim().end = Math.round($('preview').currentTime * 10) / 10;
      renderTrim();
    });
    $('preview-range').addEventListener('click', () => {
      try {
        clipRanges('', trim().start, trim().end, trim().duration);
        $('preview').currentTime = Number(trim().start);
        state.playingRange = true;
        $('preview')
          .play()
          .catch(() =>
            notice('Press play in the preview to watch this range.')
          );
      } catch (error) {
        notice(error.message, true);
      }
    });
    state.timer = window.setInterval(poll, 10000);
    window.addEventListener('pagehide', () => {
      window.clearInterval(state.timer);
      if (state.pending) window.URL.revokeObjectURL(state.pending.url);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) poll();
    });
  }
  bind();
  return { start: () => refresh(), refresh, poll, state };
}

if (typeof document !== 'undefined')
  await createWorkspace(document, window).start();
