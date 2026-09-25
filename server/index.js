'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const { relocalize, buildAnchor } = require('./reanchor');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ----------------------------- 工具函数 ----------------------------- */

function validateType(type) {
  if (!['light', 'sound'].includes(type)) {
    const e = new Error('提示类型必须为 light（灯光）或 sound（音效）');
    e.status = 400;
    throw e;
  }
}

function getScriptOr404(scriptId) {
  const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
  if (!script) {
    const e = new Error('剧本不存在');
    e.status = 404;
    throw e;
  }
  return script;
}

/**
 * 待确认提示的候选行存于 issue_detail（格式 __CANDIDATES__{json}），
 * 解析出展示文案与候选行列表。
 */
function parseCue(c) {
  let candidates = [];
  let detail = c.issue_detail || '';
  if (detail.startsWith('__CANDIDATES__')) {
    try {
      const parsed = JSON.parse(detail.replace('__CANDIDATES__', ''));
      detail = parsed.detail;
      candidates = parsed.candidates;
    } catch {
      detail = '';
    }
  }
  return {
    ...c,
    context_before: c.context_before ? JSON.parse(c.context_before) : [],
    context_after: c.context_after ? JSON.parse(c.context_after) : [],
    issue:
      c.anchor_status === 'pending'
        ? { type: c.issue_type, detail, candidates }
        : null,
  };
}

function listCues(scriptId) {
  return db
    .prepare('SELECT * FROM cues WHERE script_id = ? ORDER BY id')
    .all(scriptId)
    .map(parseCue);
}

/* ----------------------------- 剧本接口 ----------------------------- */

// 剧本列表（不含正文）
app.get('/api/scripts', (req, res) => {
  const scripts = db
    .prepare(
      `SELECT s.id, s.title, s.current_version, s.created_at, s.updated_at,
              COUNT(c.id) AS cue_count,
              SUM(CASE WHEN c.anchor_status = 'pending' THEN 1 ELSE 0 END) AS pending_count
       FROM scripts s
       LEFT JOIN cues c ON c.script_id = s.id
       GROUP BY s.id
       ORDER BY s.updated_at DESC`
    )
    .all();
  res.json(scripts);
});

// 剧本详情（含全部提示）
app.get('/api/scripts/:id', (req, res) => {
  const script = getScriptOr404(req.params.id);
  res.json({ ...script, cues: listCues(script.id) });
});

// 新建剧本
app.post('/api/scripts', (req, res) => {
  const title = (req.body.title || '').trim();
  const content = typeof req.body.content === 'string' ? req.body.content : '';
  if (!title) return res.status(400).json({ error: '剧本标题不能为空' });

  const result = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO scripts (title, content) VALUES (?, ?)')
      .run(title, content);
    db.prepare(
      'INSERT INTO script_versions (script_id, version, title, content) VALUES (?, 1, ?, ?)'
    ).run(info.lastInsertRowid, title, content);
    return info.lastInsertRowid;
  })();

  res.status(201).json({ id: result });
});

// 修改标题
app.patch('/api/scripts/:id', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: '剧本标题不能为空' });
  db.prepare("UPDATE scripts SET title = ?, updated_at = datetime('now') WHERE id = ?").run(
    title,
    script.id
  );
  res.json({ ok: true });
});

// 保存新版正文 -> 全部提示重新定位
app.put('/api/scripts/:id/content', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const content = typeof req.body.content === 'string' ? req.body.content : null;
  if (content === null) return res.status(400).json({ error: '缺少 content 字段' });

  const outcome = db.transaction(() => {
    const newVersion = script.current_version + 1;
    db.prepare(
      `UPDATE scripts SET content = ?, current_version = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(content, newVersion, script.id);
    db.prepare(
      'INSERT INTO script_versions (script_id, version, title, content) VALUES (?, ?, ?, ?)'
    ).run(script.id, newVersion, script.title, content);

    const cues = db.prepare('SELECT * FROM cues WHERE script_id = ?').all(script.id);
    const { results, stats } = relocalize(cues, content);

    const boundStmt = db.prepare(
      `UPDATE cues SET version = ?, line_no = ?, line_text = ?, anchor_status = 'bound',
                       issue_type = NULL, issue_detail = NULL, updated_at = datetime('now')
       WHERE id = ?`
    );
    const pendingStmt = db.prepare(
      `UPDATE cues SET version = ?, line_no = NULL, line_text = NULL, anchor_status = 'pending',
                       issue_type = ?, issue_detail = ?, updated_at = datetime('now')
       WHERE id = ?`
    );

    for (const r of results) {
      if (r.status === 'bound') {
        boundStmt.run(newVersion, r.lineNo, r.lineText, r.cueId);
      } else {
        const payload = '__CANDIDATES__' + JSON.stringify({
          detail: r.issueDetail,
          candidates: r.candidates || [],
        });
        pendingStmt.run(newVersion, r.issueType, payload, r.cueId);
      }
    }
    return { version: newVersion, stats };
  })();

  res.json({ ok: true, ...outcome });
});

// 删除剧本
app.delete('/api/scripts/:id', (req, res) => {
  getScriptOr404(req.params.id);
  db.prepare('DELETE FROM scripts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ----------------------------- 提示接口 ----------------------------- */

// 在某行旁添加提示（同时生成锚点与上下文快照）
app.post('/api/scripts/:id/cues', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const { type, label, note, lineNo } = req.body;
  validateType(type);
  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: '提示内容不能为空' });
  }
  const lineIndex = Number(lineNo) - 1;
  if (!Number.isInteger(lineIndex)) {
    return res.status(400).json({ error: '请选择提示所附着的台词行' });
  }

  const anchor = buildAnchor(script.content, lineIndex);
  const info = db
    .prepare(
      `INSERT INTO cues (script_id, type, label, note, version, line_no, line_text,
                         anchor_index, anchor_text, context_before, context_after, anchor_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bound')`
    )
    .run(
      script.id,
      type,
      String(label).trim(),
      (note || '').trim(),
      script.current_version,
      lineIndex + 1,
      anchor.anchorText,
      lineIndex,
      anchor.anchorText,
      JSON.stringify(anchor.contextBefore),
      JSON.stringify(anchor.contextAfter)
    );
  res.status(201).json({ id: info.lastInsertRowid });
});

// 编辑提示文案（不改动锚点）
app.patch('/api/cues/:cueId', (req, res) => {
  const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(req.params.cueId);
  if (!cue) return res.status(404).json({ error: '提示不存在' });

  const type = req.body.type !== undefined ? req.body.type : cue.type;
  validateType(type);
  const label = req.body.label !== undefined ? String(req.body.label).trim() : cue.label;
  if (!label) return res.status(400).json({ error: '提示内容不能为空' });
  const note = req.body.note !== undefined ? String(req.body.note).trim() : cue.note;

  db.prepare(
    `UPDATE cues SET type = ?, label = ?, note = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(type, label, note, cue.id);
  res.json({ ok: true });
});

// 人工重新绑定：把提示挂到当前版本指定行，并重做锚点快照
app.post('/api/cues/:cueId/rebind', (req, res) => {
  const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(req.params.cueId);
  if (!cue) return res.status(404).json({ error: '提示不存在' });
  const script = getScriptOr404(cue.script_id);

  const lineIndex = Number(req.body.lineNo) - 1;
  if (!Number.isInteger(lineIndex)) {
    return res.status(400).json({ error: '请选择要绑定的台词行' });
  }
  const anchor = buildAnchor(script.content, lineIndex);

  db.prepare(
    `UPDATE cues SET version = ?, line_no = ?, line_text = ?, anchor_index = ?, anchor_text = ?,
                     context_before = ?, context_after = ?, anchor_status = 'bound',
                     issue_type = NULL, issue_detail = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    script.current_version,
    lineIndex + 1,
    anchor.anchorText,
    lineIndex,
    anchor.anchorText,
    JSON.stringify(anchor.contextBefore),
    JSON.stringify(anchor.contextAfter),
    cue.id
  );
  res.json({ ok: true });
});

// 删除提示
app.delete('/api/cues/:cueId', (req, res) => {
  const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(req.params.cueId);
  if (!cue) return res.status(404).json({ error: '提示不存在' });
  db.prepare('DELETE FROM cues WHERE id = ?').run(cue.id);
  res.json({ ok: true });
});

/* ----------------------------- 排练场次接口 ----------------------------- */

/** 409：请求基于过期的场次进度（重复执行/越序执行/撤回错对象） */
function conflict(message) {
  const e = new Error(message);
  e.status = 409;
  return e;
}

function getSessionOr404(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    const e = new Error('场次不存在');
    e.status = 404;
    throw e;
  }
  return session;
}

/** 取当前版本已绑定、可执行的提示，按行号、提示 ID 排序 */
function executableCues(scriptId) {
  return db
    .prepare(
      `SELECT * FROM cues
       WHERE script_id = ? AND anchor_status = 'bound' AND line_no IS NOT NULL
       ORDER BY line_no ASC, id ASC`
    )
    .all(scriptId);
}

function countPendingCues(scriptId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM cues WHERE script_id = ? AND anchor_status = 'pending'")
    .get(scriptId).n;
}

/** 组装场次完整状态（含冻结条目快照、进度与执行记录） */
function serializeSession(session) {
  const items = db
    .prepare('SELECT * FROM session_items WHERE session_id = ? ORDER BY seq ASC')
    .all(session.id);
  const execs = db
    .prepare(
      `SELECT e.id, e.item_id, e.seq, e.executed_at,
              i.line_no, i.type, i.label, i.line_text
       FROM session_executions e
       JOIN session_items i ON i.id = e.item_id
       WHERE e.session_id = ?
       ORDER BY e.seq ASC`
    )
    .all(session.id);
  const executedItemIds = new Set(execs.map((x) => x.item_id));

  return {
    ...session,
    progress: execs.length,
    is_complete: execs.length >= session.total,
    items: items.map((it) => ({
      ...it,
      executed: executedItemIds.has(it.id),
    })),
    executions: execs,
  };
}

// 创建前预览：当前版本、可冻结提示数、被排除的待确认提示数
app.get('/api/scripts/:id/sessions/preview', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const cues = executableCues(script.id);
  res.json({
    script_id: script.id,
    title: script.title,
    version: script.current_version,
    total: cues.length,
    excluded_pending: countPendingCues(script.id),
    cues: cues.map((c) => ({
      id: c.id,
      line_no: c.line_no,
      type: c.type,
      label: c.label,
      note: c.note,
      line_text: c.line_text,
    })),
  });
});

// 从剧本当前版本创建场次（冻结行号/类型/内容/备注；无可执行提示不创建空场次）
app.post('/api/scripts/:id/sessions', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const name =
    req.body.name && String(req.body.name).trim()
      ? String(req.body.name).trim()
      : `${script.title} · 第${script.current_version}版排练`;

  const sessionId = db.transaction(() => {
    const cues = executableCues(script.id);
    if (cues.length === 0) {
      // 空场次没有任何意义：待确认提示无法执行，直接拒绝
      throw conflict('当前版本没有可执行的已绑定提示，无法创建场次');
    }
    const pending = countPendingCues(script.id);

    const info = db
      .prepare(
        `INSERT INTO sessions (script_id, name, script_version, total, excluded_pending)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(script.id, name, script.current_version, cues.length, pending);
    const sid = info.lastInsertRowid;

    const itemStmt = db.prepare(
      `INSERT INTO session_items (session_id, seq, cue_id, line_no, type, label, note, line_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    cues.forEach((c, i) => {
      itemStmt.run(sid, i + 1, c.id, c.line_no, c.type, c.label, c.note, c.line_text || '');
    });
    return sid;
  })();

  res.status(201).json({ id: sessionId });
});

// 场次列表（进度摘要）
app.get('/api/scripts/:id/sessions', (req, res) => {
  getScriptOr404(req.params.id);
  const sessions = db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM session_executions e WHERE e.session_id = s.id) AS progress
       FROM sessions s
       WHERE s.script_id = ?
       ORDER BY s.created_at DESC, s.id DESC`
    )
    .all(req.params.id)
    .map((s) => ({ ...s, is_complete: s.progress >= s.total }));
  res.json(sessions);
});

// 场次详情（快照与执行记录）
app.get('/api/sessions/:sessionId', (req, res) => {
  res.json(serializeSession(getSessionOr404(req.params.sessionId)));
});

// 执行队首条目：提交目标条目与预期进度做乐观锁校验
app.post('/api/sessions/:sessionId/execute', (req, res) => {
  const session = getSessionOr404(req.params.sessionId);
  const itemId = Number(req.body.itemId);
  const expectedProgress = Number(req.body.expectedProgress);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: '缺少要执行的目标条目' });
  }
  if (!Number.isInteger(expectedProgress) || expectedProgress < 0) {
    return res.status(400).json({ error: '缺少预期进度 expectedProgress' });
  }

  const result = db.transaction(() => {
    const done = db
      .prepare('SELECT COUNT(*) AS n FROM session_executions WHERE session_id = ?')
      .get(session.id).n;

    // 过期请求：客户端看到的进度已经不是服务端当前进度
    if (done !== expectedProgress) {
      throw conflict('场次进度已变化，请刷新后重试（你的请求已过期）');
    }
    if (done >= session.total) {
      throw conflict('本场次已全部执行完毕，不能推进下一条');
    }

    // 一次只能执行队首
    const head = db
      .prepare('SELECT * FROM session_items WHERE session_id = ? ORDER BY seq ASC LIMIT 1 OFFSET ?')
      .get(session.id, done);
    if (!head) throw conflict('找不到下一条可执行条目');
    if (head.id !== itemId) {
      throw conflict('只能执行队首条目，不能跳过或乱序执行');
    }

    try {
      db.prepare(
        'INSERT INTO session_executions (session_id, item_id, seq) VALUES (?, ?, ?)'
      ).run(session.id, head.id, done + 1);
    } catch (err) {
      // UNIQUE 冲突 = 该条目已执行（重复请求）
      if (String(err.message).includes('UNIQUE')) {
        throw conflict('该条目已执行，请勿重复提交');
      }
      throw err;
    }
    return done + 1;
  })();

  res.json({ ok: true, progress: result });
});

// 撤回最后执行的一条（同样带乐观锁）
app.post('/api/sessions/:sessionId/undo', (req, res) => {
  const session = getSessionOr404(req.params.sessionId);
  const expectedProgress = Number(req.body.expectedProgress);
  if (!Number.isInteger(expectedProgress) || expectedProgress < 0) {
    return res.status(400).json({ error: '缺少预期进度 expectedProgress' });
  }

  const result = db.transaction(() => {
    const last = db
      .prepare(
        `SELECT * FROM session_executions WHERE session_id = ?
         ORDER BY seq DESC LIMIT 1`
      )
      .get(session.id);
    if (!last) throw conflict('没有可撤回的执行记录');

    const done = db
      .prepare('SELECT COUNT(*) AS n FROM session_executions WHERE session_id = ?')
      .get(session.id).n;
    if (done !== expectedProgress) {
      throw conflict('场次进度已变化，请刷新后重试（你的撤回请求已过期）');
    }

    db.prepare('DELETE FROM session_executions WHERE id = ?').run(last.id);
    return done - 1;
  })();

  res.json({ ok: true, progress: result });
});

/* ----------------------------- 错误处理 ----------------------------- */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`台词提示单已启动: http://localhost:${PORT}`);
});
