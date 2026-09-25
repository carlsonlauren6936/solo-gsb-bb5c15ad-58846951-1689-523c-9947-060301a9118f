'use strict';

/* =============================== 状态 =============================== */

const state = {
  view: 'list', // 'list' | 'detail'
  tab: 'cue', // 'cue' | 'run'
  mode: 'view', // 'view' | 'edit'
  script: null, // 当前剧本详情 { id, title, content, current_version, cues }
  cueModal: null, // { mode:'add', lineNo } | { mode:'edit', cue }
  rebindCue: null, // 正在重绑的提示
  rebindTarget: null, // 重绑弹窗中暂选行号
  flashLineNo: null, // 渲染后需要高亮的行
  run: {
    preview: null, // 创建前预览 { version, total, excluded_pending, cues }
    sessions: [], // 历次场次摘要
    activeSession: null, // 当前打开的场次完整状态
  },
};

const $ = (id) => document.getElementById(id);

/* =============================== 工具 =============================== */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('toast-error', !!isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const typeName = { light: '灯光', sound: '音效' };

/* =============================== 视图切换 =============================== */

function showView(view) {
  state.view = view;
  $('listView').classList.toggle('hidden', view !== 'list');
  $('detailView').classList.toggle('hidden', view !== 'detail');
  window.scrollTo(0, 0);
}

function setMode(mode) {
  state.mode = mode;
  const editing = mode === 'edit';
  $('scriptViewer').classList.toggle('hidden', editing);
  $('scriptEditor').classList.toggle('hidden', !editing);
  $('editBtn').classList.toggle('hidden', editing);
  $('saveVersionBtn').classList.toggle('hidden', !editing);
  $('cancelEditBtn').classList.toggle('hidden', !editing);
  $('scriptModeHint').textContent = editing
    ? '修改后点击「保存新版」，系统会重新定位所有提示；无法唯一确认的将标记待确认。'
    : '点击任意台词行，可在旁边添加提示';
}

/* =============================== 剧本列表 =============================== */

async function loadScripts() {
  const scripts = await api('GET', '/api/scripts');
  const box = $('scriptList');
  if (scripts.length === 0) {
    box.innerHTML = '<div class="empty">还没有剧本，先在上方创建一个吧。</div>';
    return;
  }
  box.innerHTML = scripts
    .map((s) => {
      const pending = s.pending_count || 0;
      return `
      <div class="script-item" data-id="${s.id}">
        <div>
          <div class="script-item-title">${escapeHtml(s.title)}</div>
          <div class="script-item-meta">
            v${s.current_version}
            <span class="sep">·</span>${s.cue_count} 条提示
            ${pending > 0 ? `<span class="sep">·</span><span style="color:var(--danger)">${pending} 条待确认</span>` : ''}
            <span class="sep">·</span>更新于 ${escapeHtml(s.updated_at)}
          </div>
        </div>
        <button class="btn btn-sm btn-danger" data-action="delete" data-id="${s.id}">删除</button>
      </div>`;
    })
    .join('');
}

$('scriptList').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-action="delete"]');
  if (delBtn) {
    e.stopPropagation();
    const id = delBtn.dataset.id;
    if (!confirm('确定删除该剧本及其全部提示？此操作不可恢复。')) return;
    await api('DELETE', `/api/scripts/${id}`);
    toast('剧本已删除');
    loadScripts();
    return;
  }
  const item = e.target.closest('.script-item');
  if (item) openScript(item.dataset.id);
});

$('createBtn').addEventListener('click', async () => {
  const title = $('newTitle').value.trim();
  const content = $('newContent').value;
  if (!title) return toast('请填写剧本标题', true);
  const r = await api('POST', '/api/scripts', { title, content });
  $('newTitle').value = '';
  $('newContent').value = '';
  toast('剧本已创建');
  openScript(r.id);
});

/* =============================== 剧本详情 =============================== */

async function openScript(id) {
  state.script = await api('GET', `/api/scripts/${id}`);
  state.run = { preview: null, sessions: [], activeSession: null };
  $('detailTitle').textContent = state.script.title;
  $('topbarSub').textContent = state.script.title;
  $('scriptEditor').value = state.script.content;
  setMode('view');
  switchTab('cue');
  renderDetail();
  showView('detail');
}

function cuesByLine() {
  const map = new Map();
  for (const c of state.script.cues) {
    if (c.anchor_status === 'bound' && c.line_no != null) {
      if (!map.has(c.line_no)) map.set(c.line_no, []);
      map.get(c.line_no).push(c);
    }
  }
  return map;
}

function renderDetail() {
  const s = state.script;
  $('versionBadge').textContent = `第 ${s.current_version} 版`;

  renderViewer($('scriptViewer'), s.content, { clickable: true });
  renderCues();
}

/** 通用剧本行渲染（浏览区 & 重绑弹窗） */
function renderViewer(container, content, opts = {}) {
  const lineMap = opts.clickable ? cuesByLine() : null;
  const lines = content === '' ? [] : content.replace(/\r\n/g, '\n').split('\n');

  if (lines.length === 0) {
    container.innerHTML = '<div class="empty">剧本内容为空，请先编辑粘贴文本。</div>';
    return;
  }

  container.innerHTML = lines
    .map((text, i) => {
      const lineNo = i + 1;
      const isEmpty = text.trim() === '';
      if (isEmpty && !opts.showEmpty) {
        return `<div class="script-line empty-line"><span class="line-no">${lineNo}</span><span class="line-text">&nbsp;</span></div>`;
      }
      const cues = lineMap ? lineMap.get(lineNo) || [] : [];
      const classes = ['script-line'];
      if (!isEmpty) classes.push('selectable');
      if (cues.length) classes.push('has-cue');
      if (opts.pendingLineNos && opts.pendingLineNos.includes(lineNo)) classes.push('pending-target');
      if (state.flashLineNo === lineNo) classes.push('flash');

      const chips = cues
        .map(
          (c) =>
            `<span class="chip ${c.type === 'light' ? 'chip-light' : 'chip-sound'}">${
              c.type === 'light' ? '💡' : '🔊'
            } ${escapeHtml(c.label)}</span>`
        )
        .join('');

      return `
        <div class="${classes.join(' ')}" data-line="${lineNo}">
          <span class="line-no">${lineNo}</span>
          <span class="line-text">${escapeHtml(text) || '&nbsp;'}</span>
          ${chips ? `<span class="line-chips">${chips}</span>` : ''}
        </div>`;
    })
    .join('');

  state.flashLineNo = null;
}

function renderCues() {
  const cues = state.script.cues;
  const pending = cues.filter((c) => c.anchor_status === 'pending');
  const bound = cues
    .filter((c) => c.anchor_status === 'bound')
    .sort((a, b) => (a.line_no || 0) - (b.line_no || 0));

  $('cueStats').innerHTML = `
    <span>共 ${cues.length} 条</span>
    <span style="color:var(--ok)">已绑定 ${bound.length}</span>
    <span style="color:${pending.length ? 'var(--danger)' : 'var(--text-dim)'}">待确认 ${pending.length}</span>`;

  // 待确认面板
  const pp = $('pendingPanel');
  if (pending.length === 0) {
    pp.classList.add('hidden');
    pp.innerHTML = '';
  } else {
    pp.classList.remove('hidden');
    pp.innerHTML =
      `<h4>⚠ ${pending.length} 条提示无法唯一定位，需要人工确认</h4>
       <p class="hint" style="margin:0">系统不会把它们自动挂到其他台词上。可使用候选行一键绑定，或打开剧本点选正确行。</p>` +
      pending
        .map((c) => {
          const cands = (c.issue && c.issue.candidates) || [];
          return `
          <div class="pending-item" data-cue="${c.id}">
            <div class="pending-item-top">
              <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">
                ${c.type === 'light' ? '💡 灯光' : '🔊 音效'}
              </span>
              <strong>${escapeHtml(c.label)}</strong>
              <span class="badge badge-pending">待确认</span>
            </div>
            <div class="cue-line">原锚点台词：${escapeHtml(c.anchor_text || '（无）')}</div>
            <div class="pending-reason">${escapeHtml((c.issue && c.issue.detail) || '无法定位')}</div>
            ${
              cands.length
                ? `<div class="hint" style="margin:6px 0 2px">候选位置（第 ${cands
                    .map((x) => x.lineNo)
                    .join('、')} 行）：</div>` +
                  cands
                    .map(
                      (x) => `
                    <div class="candidate-row">
                      <button class="btn btn-sm btn-primary" data-action="bind-candidate"
                              data-cue="${c.id}" data-line="${x.lineNo}">绑到第 ${x.lineNo} 行</button>
                      <span class="candidate-line">${escapeHtml(x.lineText)}</span>
                    </div>`
                    )
                    .join('')
                : ''
            }
            <div class="cue-actions">
              <button class="btn btn-sm" data-action="rebind" data-cue="${c.id}">点选台词重绑…</button>
              <button class="btn btn-sm" data-action="edit" data-cue="${c.id}">编辑内容</button>
              <button class="btn btn-sm btn-danger" data-action="delete" data-cue="${c.id}">删除</button>
            </div>
          </div>`;
        })
        .join('');
  }

  // 已绑定提示列表
  const list = $('cueList');
  if (bound.length === 0) {
    list.innerHTML = pending.length
      ? ''
      : '<div class="empty">暂无提示。在左侧剧本中点击一句台词即可添加。</div>';
  } else {
    list.innerHTML = bound
      .map(
        (c) => `
      <div class="cue-item">
        <div class="cue-item-top">
          <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">
            ${c.type === 'light' ? '💡 灯光' : '🔊 音效'}
          </span>
          <span class="cue-label">${escapeHtml(c.label)}</span>
          <span class="badge badge-ok">第 ${c.line_no} 行 · v${c.version}</span>
        </div>
        <button class="line-link" data-action="goto" data-line="${c.line_no}">📖 ${escapeHtml(
          c.line_text || ''
        )}</button>
        ${c.note ? `<div class="cue-note">📝 ${escapeHtml(c.note)}</div>` : ''}
        <div class="cue-actions">
          <button class="btn btn-sm" data-action="add-here" data-line="${c.line_no}">同行再加提示</button>
          <button class="btn btn-sm" data-action="rebind" data-cue="${c.id}">重新绑定…</button>
          <button class="btn btn-sm" data-action="edit" data-cue="${c.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-cue="${c.id}">删除</button>
        </div>
      </div>`
      )
      .join('');
  }
}

/* 剧本区点击行 -> 添加提示 */
$('scriptViewer').addEventListener('click', (e) => {
  if (state.mode !== 'view') return;
  const line = e.target.closest('.script-line.selectable');
  if (!line) return;
  openCueModal({ mode: 'add', lineNo: Number(line.dataset.line) });
});

/* 提示单 / 待确认面板按钮事件 */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const cueId = Number(btn.dataset.cue);

  if (action === 'goto') {
    const lineNo = Number(btn.dataset.line);
    const el = $('scriptViewer').querySelector(`[data-line="${lineNo}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      state.flashLineNo = lineNo;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1500);
    }
    return;
  }

  if (action === 'add-here') {
    openCueModal({ mode: 'add', lineNo: Number(btn.dataset.line) });
    return;
  }

  const cue = cueId ? state.script.cues.find((c) => c.id === cueId) : null;

  if (action === 'edit' && cue) {
    openCueModal({ mode: 'edit', cue });
  } else if (action === 'delete' && cue) {
    if (!confirm(`确定删除提示「${cue.label}」？`)) return;
    await api('DELETE', `/api/cues/${cue.id}`);
    toast('提示已删除');
    await openScript(state.script.id);
  } else if (action === 'rebind' && cue) {
    openRebindModal(cue);
  } else if (action === 'bind-candidate') {
    const targetLine = Number(btn.dataset.line);
    await rebindCue(Number(btn.dataset.cue), targetLine, true);
  }
});

/* =============================== 提示弹窗 =============================== */

function openCueModal(modalState) {
  state.cueModal = modalState;
  const isAdd = modalState.mode === 'add';
  $('cueModalTitle').textContent = isAdd ? '添加提示' : '编辑提示';

  const type = isAdd ? 'light' : modalState.cue.type;
  document.querySelectorAll('input[name="cueType"]').forEach((r) => {
    r.checked = r.value === type;
  });
  $('cueLabel').value = isAdd ? '' : modalState.cue.label;
  $('cueNote').value = isAdd ? '' : modalState.cue.note || '';

  if (isAdd) {
    const lines = state.script.content.replace(/\r\n/g, '\n').split('\n');
    $('cueModalLine').textContent = `附着于第 ${modalState.lineNo} 行：${lines[modalState.lineNo - 1] || ''}`;
  } else {
    $('cueModalLine').textContent =
      modalState.cue.anchor_status === 'bound'
        ? `第 ${modalState.cue.line_no} 行：${modalState.cue.line_text || ''}`
        : `待确认 · 原锚点：${modalState.cue.anchor_text || '（无）'}`;
  }
  $('cueModal').classList.remove('hidden');
  $('cueLabel').focus();
}

function closeCueModal() {
  state.cueModal = null;
  $('cueModal').classList.add('hidden');
}

$('cueCancelBtn').addEventListener('click', closeCueModal);
$('cueModal').addEventListener('click', (e) => {
  if (e.target === $('cueModal')) closeCueModal();
});

$('cueSaveBtn').addEventListener('click', async () => {
  const m = state.cueModal;
  const body = {
    type: document.querySelector('input[name="cueType"]:checked').value,
    label: $('cueLabel').value.trim(),
    note: $('cueNote').value.trim(),
  };
  if (!body.label) return toast('请填写提示内容', true);

  try {
    if (m.mode === 'add') {
      await api('POST', `/api/scripts/${state.script.id}/cues`, { ...body, lineNo: m.lineNo });
      toast('提示已添加');
    } else {
      await api('PATCH', `/api/cues/${m.cue.id}`, body);
      toast('提示已保存');
    }
    closeCueModal();
    await openScript(state.script.id);
  } catch (err) {
    toast(err.message, true);
  }
});

/* =============================== 重新绑定弹窗 =============================== */

function openRebindModal(cue) {
  state.rebindCue = cue;
  state.rebindTarget = null;

  $('rebindCueInfo').innerHTML = `
    <span class="badge ${cue.type === 'light' ? 'badge-light' : 'badge-sound'}">
      ${cue.type === 'light' ? '💡 灯光' : '🔊 音效'}
    </span>
    <strong>${escapeHtml(cue.label)}</strong>`;
  $('rebindReason').textContent = cue.issue
    ? `无法自动定位原因：${cue.issue.detail}`
    : '为该提示选择正确的台词行：';

  const cands = (cue.issue && cue.issue.candidates) || [];
  $('rebindCandidates').innerHTML = cands.length
    ? cands
        .map(
          (x) => `
      <div class="candidate-row">
        <button class="btn btn-sm btn-primary" data-rebind-line="${x.lineNo}">绑到第 ${x.lineNo} 行</button>
        <span class="candidate-line">${escapeHtml(x.lineText)}</span>
      </div>`
        )
        .join('')
    : '';

  renderViewer($('rebindViewer'), state.script.content, {
    clickable: false,
    pendingLineNos: cands.map((x) => x.lineNo),
  });
  $('rebindViewer').querySelectorAll('.script-line.selectable').forEach((el) => {
    el.addEventListener('click', async () => {
      await rebindCue(cue.id, Number(el.dataset.line), true);
    });
  });

  $('rebindModal').classList.remove('hidden');
}

$('rebindCandidates').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-rebind-line]');
  if (!btn) return;
  await rebindCue(state.rebindCue.id, Number(btn.dataset.rebindLine), true);
});

async function rebindCue(cueId, lineNo, closeModal) {
  try {
    await api('POST', `/api/cues/${cueId}/rebind`, { lineNo });
    toast(`已绑定到第 ${lineNo} 行`);
    if (closeModal) $('rebindModal').classList.add('hidden');
    state.rebindCue = null;
    state.flashLineNo = lineNo;
    await openScript(state.script.id);
  } catch (err) {
    toast(err.message, true);
  }
}

$('rebindCancelBtn').addEventListener('click', () => {
  $('rebindModal').classList.add('hidden');
  state.rebindCue = null;
});
$('rebindModal').addEventListener('click', (e) => {
  if (e.target === $('rebindModal')) $('rebindModal').classList.add('hidden');
});

/* =============================== 标签页切换 =============================== */

function switchTab(tab) {
  state.tab = tab;
  $('cueTab').classList.toggle('hidden', tab !== 'cue');
  $('runTab').classList.toggle('hidden', tab !== 'run');
  $('tabCueBtn').classList.toggle('active', tab === 'cue');
  $('tabRunBtn').classList.toggle('active', tab === 'run');
  if (tab === 'run') loadRunTab();
}

$('tabCueBtn').addEventListener('click', () => switchTab('cue'));
$('tabRunBtn').addEventListener('click', () => switchTab('run'));

/* =============================== 排练执行台 =============================== */

async function loadRunTab() {
  const id = state.script.id;
  $('runPreview').textContent = '正在读取当前版本提示…';
  try {
    const [preview, sessions] = await Promise.all([
      api('GET', `/api/scripts/${id}/sessions/preview`),
      api('GET', `/api/scripts/${id}/sessions`),
    ]);
    state.run.preview = preview;
    state.run.sessions = sessions;
    renderCreateBox();
    renderSessionHistory();

    // 默认打开最近一场（刷新页面后可在此恢复进度）
    const keep = state.run.activeSession;
    const target =
      keep && sessions.some((s) => s.id === keep.id)
        ? keep.id
        : sessions.length
          ? sessions[0].id
          : null;
    if (target) {
      await openRunSession(target);
    } else {
      state.run.activeSession = null;
      renderActiveSession();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/** 创建前的预览面板：显示将冻结条目数与待确认排除数 */
function renderCreateBox() {
  const p = state.run.preview;
  const box = $('runPreview');
  if (!p) {
    box.textContent = '暂无预览';
    return;
  }
  box.innerHTML = `
    <div class="run-preview-line">
      将基于剧本<strong>第 ${p.version} 版</strong>冻结当前已绑定提示，
      共 <strong>${p.total}</strong> 条可执行条目
      （按行号、提示 ID 排序）。
    </div>
    <div class="run-preview-line ${p.excluded_pending ? 'has-pending' : ''}">
      ${
        p.excluded_pending
          ? `⚠ 有 <strong>${p.excluded_pending}</strong> 条待确认提示未定位，将被排除在场次之外；请先在「剧本与提示单」中重新绑定。`
          : '没有待确认提示被排除。'
      }
    </div>`;
  $('runCreateBtn').disabled = p.total === 0;
  $('runCreateBtn').textContent =
    p.total === 0 ? '无可执行提示，不能创建场次' : '从当前版本创建场次';
}

$('runCreateBtn').addEventListener('click', async () => {
  const name = $('runName').value.trim();
  try {
    const r = await api('POST', `/api/scripts/${state.script.id}/sessions`, { name });
    $('runName').value = '';
    toast('场次已创建，提示行号/类型/内容/备注已冻结');
    await loadRunTab();
    await openRunSession(r.id);
  } catch (err) {
    if (err.status === 409) {
      toast(err.message, true);
      loadRunTab(); // 进度/数据可能已变，静默刷新
    } else {
      toast(err.message, true);
    }
  }
});

async function openRunSession(sessionId) {
  try {
    state.run.activeSession = await api('GET', `/api/sessions/${sessionId}`);
    renderActiveSession();
    renderSessionHistory();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderActiveSession() {
  const box = $('activeSessionBox');
  const s = state.run.activeSession;
  if (!s) {
    box.innerHTML = '<div class="empty">还没有场次，从上方创建一场开始排练。</div>';
    return;
  }

  const head = s.items[s.progress] || null; // 队首（0-based 进度直接当下标）
  const headItem = head
    ? `
    <div class="run-head ${head.type === 'light' ? 'is-light' : 'is-sound'}">
      <div class="run-head-top">
        <span class="run-head-idx">下一条 · #${head.seq}</span>
        <span class="badge ${head.type === 'light' ? 'badge-light' : 'badge-sound'}">
          ${head.type === 'light' ? '💡 灯光' : '🔊 音效'}
        </span>
        <span class="run-head-label">${escapeHtml(head.label)}</span>
      </div>
      <div class="run-head-line">📖 第 ${head.line_no} 行：${escapeHtml(head.line_text)}</div>
      ${head.note ? `<div class="run-head-note">📝 ${escapeHtml(head.note)}</div>` : ''}
    </div>`
    : `<div class="run-head run-done">🎉 本场次 ${s.total} 条提示已全部执行完毕</div>`;

  box.innerHTML = `
    <div class="run-session-head">
      <div class="run-session-title">${escapeHtml(s.name)}</div>
      <div class="run-session-meta">
        <span class="badge badge-version">v${s.script_version} 快照</span>
        <span>共 ${s.total} 条 · 已执行 ${s.progress} 条</span>
        ${s.is_complete ? '<span class="badge badge-ok">已完成</span>' : ''}
      </div>
    </div>

    <div class="run-progress-bar">
      <div class="run-progress-fill" style="width:${s.total ? (s.progress / s.total) * 100 : 0}%"></div>
    </div>

    ${headItem}

    <div class="run-controls">
      <button class="btn btn-primary" id="executeBtn"
        ${!head || s.is_complete ? 'disabled' : ''}>
        ▶ 执行队首（#${head ? head.seq : '—'}）
      </button>
      <button class="btn" id="undoBtn" ${s.progress === 0 ? 'disabled' : ''}>
        ↩ 撤回最后一条
      </button>
      <span class="hint" id="runConflictHint"></span>
    </div>

    <h4 class="run-subhead">提示队列（创建时冻结）</h4>
    <div class="run-queue">
      ${s.items
        .map((it) => {
          const isHead = head && it.id === head.id;
          const cls = it.executed ? 'done' : isHead ? 'head' : 'pending';
          const stateTag = it.executed
            ? '<span class="run-tag tag-done">已执行</span>'
            : isHead
              ? '<span class="run-tag tag-head">队首</span>'
              : '<span class="run-tag tag-pending">待执行</span>';
          return `
          <div class="run-item ${cls}">
            <span class="run-item-idx">#${it.seq}</span>
            ${stateTag}
            <span class="badge ${it.type === 'light' ? 'badge-light' : 'badge-sound'}">
              ${it.type === 'light' ? '💡' : '🔊'}
            </span>
            <span class="run-item-line">第 ${it.line_no} 行</span>
            <span class="run-item-label">${escapeHtml(it.label)}</span>
            ${it.note ? `<span class="run-item-note">📝 ${escapeHtml(it.note)}</span>` : ''}
          </div>`;
        })
        .join('')}
    </div>

    <h4 class="run-subhead">执行记录</h4>
    <div class="run-log">
      ${
        s.executions.length === 0
          ? '<div class="empty" style="padding:12px 0">尚无执行记录。</div>'
          : s.executions
              .slice()
              .reverse()
              .map(
                (e) => `
            <div class="run-log-row">
              <span class="run-log-time">${escapeHtml(e.executed_at)}</span>
              <span class="run-log-idx">#${e.seq}</span>
              <span class="badge ${e.type === 'light' ? 'badge-light' : 'badge-sound'}">
                ${e.type === 'light' ? '💡' : '🔊'}
              </span>
              <span class="run-item-label">${escapeHtml(e.label)}</span>
              <span class="run-item-line">第 ${e.line_no} 行</span>
            </div>`
              )
              .join('')
      }
    </div>`;

  $('executeBtn').addEventListener('click', () => executeItem(head.id));
  $('undoBtn').addEventListener('click', undoLast);
}

async function executeItem(itemId) {
  const s = state.run.activeSession;
  const expectedProgress = s.progress;
  const btn = $('executeBtn');
  btn.disabled = true;
  try {
    await api('POST', `/api/sessions/${s.id}/execute`, { itemId, expectedProgress });
    await refreshActiveSession();
  } catch (err) {
    handleRunConflict(err);
  } finally {
    if (document.body.contains(btn)) btn.disabled = false;
  }
}

async function undoLast() {
  const s = state.run.activeSession;
  const expectedProgress = s.progress;
  const btn = $('undoBtn');
  btn.disabled = true;
  try {
    await api('POST', `/api/sessions/${s.id}/undo`, { expectedProgress });
    await refreshActiveSession();
  } catch (err) {
    handleRunConflict(err);
  } finally {
    if (document.body.contains(btn)) btn.disabled = false;
  }
}

/** 冲突（过期/重复/越序）：刷新场次恢复真实进度，不推进下一条 */
function handleRunConflict(err) {
  if (err.status === 409) {
    toast(`冲突：${err.message}`, true);
    refreshActiveSession();
    refreshHistory();
  } else {
    toast(err.message, true);
  }
}

async function refreshActiveSession() {
  const s = state.run.activeSession;
  if (!s) return;
  state.run.activeSession = await api('GET', `/api/sessions/${s.id}`);
  renderActiveSession();
  refreshHistory();
}

async function refreshHistory() {
  state.run.sessions = await api('GET', `/api/scripts/${state.script.id}/sessions`);
  renderSessionHistory();
}

function renderSessionHistory() {
  const box = $('sessionHistory');
  const list = state.run.sessions;
  if (!list.length) {
    box.innerHTML = '<div class="empty">暂无历史场次。</div>';
    return;
  }
  const activeId = state.run.activeSession ? state.run.activeSession.id : null;
  box.innerHTML = list
    .map((s) => {
      const pct = s.total ? Math.round((s.progress / s.total) * 100) : 0;
      return `
      <div class="session-item ${s.id === activeId ? 'active' : ''}" data-session="${s.id}">
        <div class="session-item-top">
          <span class="session-item-name">${escapeHtml(s.name)}</span>
          ${s.is_complete ? '<span class="badge badge-ok">已完成</span>' : ''}
        </div>
        <div class="session-item-meta">
          v${s.script_version} · ${s.total} 条 · 已执行 ${s.progress} 条（${pct}%）
          ${s.excluded_pending ? ` · 排除待确认 ${s.excluded_pending} 条` : ''}
        </div>
        <div class="session-item-time">创建于 ${escapeHtml(s.created_at)}</div>
      </div>`;
    })
    .join('');
}

$('sessionHistory').addEventListener('click', (e) => {
  const item = e.target.closest('.session-item');
  if (item) openRunSession(Number(item.dataset.session));
});

/* =============================== 编辑剧本 =============================== */

$('editBtn').addEventListener('click', () => {
  $('scriptEditor').value = state.script.content;
  setMode('edit');
});

$('cancelEditBtn').addEventListener('click', () => setMode('view'));

$('saveVersionBtn').addEventListener('click', async () => {
  const content = $('scriptEditor').value;
  if (content === state.script.content) {
    toast('内容没有变化');
    setMode('view');
    return;
  }
  try {
    const r = await api('PUT', `/api/scripts/${state.script.id}/content`, { content });
    setMode('view');
    await openScript(state.script.id);
    if (r.stats.pending > 0) {
      toast(`已保存为第 ${r.version} 版：${r.stats.bound} 条自动重定位，${r.stats.pending} 条待确认`, true);
    } else {
      toast(`已保存为第 ${r.version} 版，${r.stats.bound} 条提示全部重新定位成功`);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

$('renameBtn').addEventListener('click', async () => {
  const title = prompt('修改剧本标题：', state.script.title);
  if (title == null) return;
  if (!title.trim()) return toast('标题不能为空', true);
  await api('PATCH', `/api/scripts/${state.script.id}`, { title: title.trim() });
  toast('标题已更新');
  openScript(state.script.id);
});

$('backBtn').addEventListener('click', goHome);
$('homeBtn').addEventListener('click', goHome);

async function goHome() {
  $('topbarSub').textContent = '灯光 / 音效提示管理';
  showView('list');
  await loadScripts();
}

/* =============================== 启动 =============================== */

loadScripts().catch((err) => toast(err.message, true));
