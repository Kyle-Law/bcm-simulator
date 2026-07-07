/* UI wiring: terminal, rack elevation, guided lessons, troubleshooting labs.
 *
 * A "scenario" is either a guided lesson (step-by-step) or a troubleshooting lab
 * (fix a broken cluster; graded on state). Only one scenario is active at a time.
 * Starting one loads its own cluster fixture, so learning stays isolated. */

(function () {
  'use strict';

  const termEl = document.getElementById('term');
  const outEl = document.getElementById('term-out');
  const promptEl = document.getElementById('term-prompt');
  const inputEl = document.getElementById('term-input');
  const rackEl = document.getElementById('rack');
  const lessonsEl = document.getElementById('lessons');
  const labsEl = document.getElementById('labs');
  const lessonProgressEl = document.getElementById('lesson-progress');
  const labProgressEl = document.getElementById('lab-progress');
  const nodesUpEl = document.getElementById('nodes-up');
  const chipModifiedEl = document.getElementById('chip-modified');

  const LESSONS = CmshLessons.LESSONS;
  const LABS = CmshLabs.LABS;
  const STORAGE_KEY = 'bcm-cmsh-trainer-progress-v2';
  const SNAPSHOT_KEY = 'bcm-cmsh-trainer-snapshot-v1';

  /* ---------- progress ---------- */

  let progress = { lessons: {}, labs: {}, active: null };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.lessons) progress = saved;
  } catch (e) { /* ignore */ }

  function saveProgress() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch (e) { /* private mode */ }
  }

  const lessonSteps = id => progress.lessons[id] || 0;
  const labSolved = id => !!progress.labs[id];

  // The scenario currently being graded and driving the cluster.
  let active = null; // { kind: 'lesson' | 'lab', id, drill? }
  const openLessons = new Set();
  const openLabs = new Set();
  const labHintsShown = {}; // transient: how many hints revealed per lab

  // Recover which scenario was active, lesson or lab. Whether we can recover
  // its exact cluster state too (not just which one it was) depends on
  // whether a matching snapshot exists — see the boot section below.
  if (progress.active &&
      ((progress.active.kind === 'lesson' && LESSONS.some(l => l.id === progress.active.id)) ||
       (progress.active.kind === 'lab' && LABS.some(l => l.id === progress.active.id)))) {
    active = progress.active;
  } else {
    active = { kind: 'lesson', id: LESSONS[0].id };
  }
  if (active.kind === 'lesson') openLessons.add(active.id);
  else if (!active.drill) openLabs.add(active.id);

  function setActive(kind, id, extra) {
    active = Object.assign({ kind, id }, extra || {});
    progress.active = active;
    saveProgress();
  }

  /* ---------- engine ---------- */

  let inCommand = false; // true while a typed command runs synchronously
  let loading = false;   // true while a fixture is being loaded

  const engine = new Cmsh.CmshEngine({
    makeInitialState: CmshState.makeInitialState,
    onEvent: lines => { appendLines(lines); scrollTerm(); },
    onStateChange: () => {
      renderRack();
      renderChips();
      renderPrompt();
      if (!inCommand && !loading) gradeActive('');
      scheduleSnapshotSave();
    },
  });

  /* ---------- snapshot persistence ----------
   * Keeps a page reload from silently dropping the active scenario's cluster
   * fixture — without this, reloading mid-lab (or mid-lesson, for lessons
   * with their own setup fixture) would quietly swap back to a healthy base
   * cluster while the UI still claimed the scenario was in progress. */

  let snapshotTimer = null;

  function saveSnapshot() {
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ scenario: active, snap: engine.snapshot() }));
    } catch (e) { /* private mode or quota exceeded */ }
  }

  function scheduleSnapshotSave() {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(saveSnapshot, 350);
  }

  /* ---------- terminal rendering ---------- */

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlight(s) {
    return escapeHtml(s)
      .replace(/\[ (UP|ON) \]/g, '<span class="st-up">[ $1 ]</span>')
      .replace(/\[ (DOWN|OFF|CLOSED) \]/g, '<span class="st-down">[ $1 ]</span>')
      .replace(/\[ (INSTALLER_BOOTING|INSTALLING|RESET) \]/g, '<span class="st-boot">[ $1 ]</span>');
  }

  function appendLines(lines) {
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      const div = document.createElement('div');
      div.className = 'term-line' + (l.cls ? ' ' + l.cls : '');
      div.innerHTML = highlight(l.text) || '&nbsp;';
      frag.appendChild(div);
    }
    outEl.appendChild(frag);
  }

  function echoCommand(cmd) {
    const div = document.createElement('div');
    div.className = 'term-line echo';
    const p = document.createElement('span');
    p.className = 'term-prompt';
    p.textContent = engine.prompt();
    div.appendChild(p);
    div.appendChild(document.createTextNode(cmd));
    outEl.appendChild(div);
  }

  function scrollTerm() { termEl.scrollTop = termEl.scrollHeight; }
  function renderPrompt() { promptEl.textContent = engine.prompt(); }

  function banner() {
    appendLines([
      { text: 'BCM cmsh simulator — a safe practice environment; nothing here touches real hardware.', cls: 'muted' },
      { text: 'Type "help" to explore, or pick a lesson or troubleshooting lab on the right.', cls: 'muted' },
      { text: '' },
    ]);
  }

  /* ---------- command execution ---------- */

  const history = [];
  let historyIdx = -1;
  let pendingInput = '';

  function runCommand(raw) {
    const cmd = raw.trim();
    echoCommand(raw);
    inCommand = true;
    if (cmd) {
      history.push(cmd);
      const output = engine.execute(cmd);
      appendLines(output);
    }
    inCommand = false;
    if (cmd) gradeActive(cmd);
    historyIdx = -1;
    pendingInput = '';
    renderPrompt();
    renderRack();
    renderChips();
    scrollTerm();
  }

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = inputEl.value;
      inputEl.value = '';
      runCommand(v);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!history.length) return;
      if (historyIdx === -1) { pendingInput = inputEl.value; historyIdx = history.length; }
      historyIdx = Math.max(0, historyIdx - 1);
      inputEl.value = history[historyIdx];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === -1) return;
      historyIdx++;
      if (historyIdx >= history.length) { historyIdx = -1; inputEl.value = pendingInput; }
      else inputEl.value = history[historyIdx];
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const { matches, current } = engine.complete(inputEl.value);
      if (!matches.length) return;
      if (matches.length === 1) {
        inputEl.value = inputEl.value.slice(0, inputEl.value.length - current.length) + matches[0] + ' ';
        return;
      }
      let prefix = matches[0];
      for (const m of matches) {
        while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
      }
      if (prefix.length > current.length) {
        inputEl.value = inputEl.value.slice(0, inputEl.value.length - current.length) + prefix;
      } else {
        echoCommand(inputEl.value);
        appendLines([{ text: matches.join('   '), cls: 'muted' }]);
        scrollTerm();
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      outEl.innerHTML = '';
    } else if (e.key === 'c' && e.ctrlKey && !window.getSelection().toString()) {
      e.preventDefault();
      echoCommand(inputEl.value + '^C');
      inputEl.value = '';
      scrollTerm();
    }
  });

  termEl.addEventListener('mouseup', () => {
    if (!window.getSelection().toString()) inputEl.focus();
  });

  /* ---------- rack view ---------- */

  function ledClass(d) {
    if (d.status === 'UP') return 'led-up';
    if (d.status === 'INSTALLER_BOOTING' || d.status === 'INSTALLING') return 'led-boot';
    return 'led-down';
  }

  function renderRack() {
    const devs = engine.state.devices;
    const order = Object.keys(devs).sort((a, b) => {
      const rank = n => devs[n].type === 'EthernetSwitch' ? 0 : devs[n].type === 'HeadNode' ? 1 : 2;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    rackEl.innerHTML = '';
    for (const name of order) {
      const d = devs[name];
      const ru = document.createElement('div');
      ru.className = 'ru' + (d.type === 'HeadNode' ? ' ru-head' : '');

      const led = document.createElement('span');
      led.className = 'led ' + ledClass(d);
      ru.appendChild(led);

      const nm = document.createElement('span');
      nm.className = 'ru-name';
      nm.textContent = name;
      ru.appendChild(nm);

      if (d.category) {
        const tag = document.createElement('span');
        tag.className = 'ru-tag' + (d.category.includes('gpu') ? ' ru-tag-gpu' : '');
        tag.textContent = d.category;
        ru.appendChild(tag);
      } else if (d.type !== 'PhysicalNode') {
        const tag = document.createElement('span');
        tag.className = 'ru-tag';
        tag.textContent = d.type === 'HeadNode' ? 'head' : 'switch';
        ru.appendChild(tag);
      }

      const st = document.createElement('span');
      st.className = 'ru-status';
      st.textContent = d.status;
      ru.appendChild(st);

      rackEl.appendChild(ru);
    }
  }

  /* ---------- chips ---------- */

  function renderChips() {
    const devs = Object.values(engine.state.devices);
    const up = devs.filter(d => d.status === 'UP').length;
    nodesUpEl.textContent = up + '/' + devs.length;
    const anyStaged = Object.values(engine.session.staged)
      .some(s => s.isNew || s.removed || Object.keys(s.props).length);
    chipModifiedEl.classList.toggle('hidden', !anyStaged);
  }

  /* ---------- grading ---------- */

  function gradeActive(cmd) {
    if (!active) return;
    if (active.kind === 'lesson') checkLesson(cmd);
    else if (active.kind === 'lab') checkLab();
  }

  function checkLesson(cmd) {
    const lesson = LESSONS.find(l => l.id === active.id);
    if (!lesson) return;
    let done = lessonSteps(lesson.id);
    const ctx = { engine, cmd: cmd || '', output: '' };
    let advanced = false;
    while (done < lesson.steps.length && lesson.steps[done].check(ctx)) {
      done++;
      advanced = true;
    }
    if (advanced) {
      progress.lessons[lesson.id] = done;
      saveProgress();
      renderLessons();
      if (done === lesson.steps.length) {
        appendLines([{ text: '✔ Lesson complete: ' + lesson.title, cls: 'ok' }]);
        scrollTerm();
      }
    }
  }

  function checkLab() {
    const lab = LABS.find(l => l.id === active.id);
    if (!lab) return;
    const solvedNow = lab.goals.every(g => g.done(engine));
    if (solvedNow && !labSolved(lab.id)) {
      progress.labs[lab.id] = true;
      const wasDrill = !!active.drill;
      if (wasDrill) { active.drill = false; progress.active = active; openLabs.add(lab.id); }
      saveProgress();
      appendLines([
        { text: '' },
        { text: wasDrill
            ? '✔ Drill solved — it was: ' + lab.title + ' (' + lab.difficulty + ').'
            : '✔ Lab solved: ' + lab.title + ' — all goals met.',
          cls: 'ok' },
      ]);
      scrollTerm();
    }
    renderLabs();
  }

  /* ---------- starting scenarios ---------- */

  function loadFixture(setup) {
    loading = true;
    engine.reset(setup);
    loading = false;
  }

  function startLesson(id) {
    const lesson = LESSONS.find(l => l.id === id);
    if (!lesson) return;
    loadFixture(lesson.setup);
    progress.lessons[id] = 0;
    setActive('lesson', id);
    openLessons.add(id);
    outEl.innerHTML = '';
    appendLines([
      { text: '── Lesson: ' + lesson.title + ' ──', cls: 'muted' },
      { text: lesson.blurb, cls: 'muted' },
      { text: 'Follow the steps on the right; each ticks off automatically. Stuck? Use "show hint".', cls: 'muted' },
      { text: '' },
    ]);
    renderAll();
    scrollTerm();
    inputEl.focus();
  }

  function startLab(id, opts) {
    opts = opts || {};
    const lab = LABS.find(l => l.id === id);
    if (!lab) return;
    loadFixture(lab.setup);
    setActive('lab', id, { drill: !!opts.drill });
    labHintsShown[id] = 0;
    outEl.innerHTML = '';
    if (opts.drill) {
      openLabs.delete(id);
      appendLines([
        { text: '── Drill: unidentified fault ──', cls: 'muted' },
        { text: 'Something is wrong with this cluster. Investigate with "status", "events", and "show", diagnose the problem, and fix it.', cls: 'muted' },
        { text: 'This is a random pick from the troubleshooting labs — its name stays hidden until you solve it (or click Reveal).', cls: 'muted' },
        { text: '' },
      ]);
    } else {
      openLabs.add(id);
      appendLines([
        { text: '── Troubleshooting lab: ' + lab.title + ' (' + lab.difficulty + ') ──', cls: 'muted' },
        ...wrap(lab.briefing).map(t => ({ text: t, cls: 'muted' })),
        { text: '' },
        { text: 'Goals:', cls: 'muted' },
        ...lab.goals.map(g => ({ text: '  ▢ ' + g.text, cls: 'muted' })),
        { text: '' },
        { text: 'Investigate with "status", "events", "show", then fix and commit. Hints are on the right.', cls: 'muted' },
        { text: '' },
      ]);
    }
    renderAll();
    // Re-grade in case the fixture already satisfies a goal (it shouldn't).
    checkLab();
    saveSnapshot();
    scrollTerm();
    inputEl.focus();
  }

  function startDrill() {
    // Prefer an unsolved lab so the drill has something to teach; if
    // everything is already solved, any lab still works as a timed replay.
    const unsolved = LABS.filter(l => !labSolved(l.id));
    const pool = unsolved.length ? unsolved : LABS;
    const lab = pool[Math.floor(Math.random() * pool.length)];
    startLab(lab.id, { drill: true });
  }

  function revealDrill(id) {
    if (!(active && active.kind === 'lab' && active.id === id && active.drill)) return;
    active.drill = false;
    progress.active = active;
    saveProgress();
    openLabs.add(id);
    const lab = LABS.find(l => l.id === id);
    appendLines([{ text: '' }, { text: 'Revealed: ' + lab.title + ' (' + lab.difficulty + ')', cls: 'event' }, { text: '' }]);
    renderAll();
    saveSnapshot();
    scrollTerm();
  }

  // Wrap prose to ~76 columns for the terminal.
  function wrap(text, width) {
    width = width || 76;
    const words = text.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > width) { lines.push(cur); cur = w; }
      else cur = (cur ? cur + ' ' : '') + w;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /* ---------- lessons panel ---------- */

  function renderLessons() {
    lessonsEl.innerHTML = '';
    let completed = 0;

    LESSONS.forEach((lesson, li) => {
      const done = lessonSteps(lesson.id);
      const isDone = done >= lesson.steps.length;
      if (isDone) completed++;

      const wrapEl = document.createElement('div');
      wrapEl.className = 'lesson' +
        (openLessons.has(lesson.id) ? ' open' : '') +
        (active && active.kind === 'lesson' && active.id === lesson.id ? ' active' : '') +
        (isDone ? ' done' : '');

      const head = document.createElement('button');
      head.className = 'lesson-head';
      head.setAttribute('aria-expanded', openLessons.has(lesson.id));
      head.innerHTML =
        '<span class="lesson-num">' + (li + 1) + '</span>' +
        '<span class="lesson-title">' + lesson.title + '</span>' +
        '<span class="lesson-check">' + (isDone ? '✔ done' : done + '/' + lesson.steps.length) + '</span>';
      head.addEventListener('click', () => {
        if (openLessons.has(lesson.id)) openLessons.delete(lesson.id);
        else openLessons.add(lesson.id);
        setActive('lesson', lesson.id);
        renderLessons();
        inputEl.focus();
      });
      wrapEl.appendChild(head);

      const body = document.createElement('div');
      body.className = 'lesson-body';

      const blurb = document.createElement('p');
      blurb.className = 'lesson-blurb';
      blurb.textContent = lesson.blurb;
      body.appendChild(blurb);

      lesson.steps.forEach((step, si) => {
        const stepEl = document.createElement('div');
        stepEl.className = 'step' + (si < done ? ' done' : si === done ? ' current' : '');

        const box = document.createElement('span');
        box.className = 'step-box';
        box.textContent = si < done ? '✔' : '';
        stepEl.appendChild(box);

        const txt = document.createElement('div');
        txt.appendChild(document.createTextNode(step.text));

        if (si === done && active && active.kind === 'lesson' && active.id === lesson.id) {
          const hintBtn = document.createElement('button');
          hintBtn.className = 'step-hint';
          hintBtn.textContent = 'show hint';
          hintBtn.addEventListener('click', () => {
            const cmdEl = document.createElement('span');
            cmdEl.className = 'step-hint-cmd';
            cmdEl.textContent = '% ' + step.hint;
            cmdEl.title = 'Click to type this into the terminal';
            cmdEl.addEventListener('click', () => { inputEl.value = step.hint; inputEl.focus(); });
            hintBtn.replaceWith(cmdEl);
          });
          txt.appendChild(hintBtn);
        }

        stepEl.appendChild(txt);
        body.appendChild(stepEl);
      });

      const actions = document.createElement('div');
      actions.className = 'scenario-actions';
      const startBtn = document.createElement('button');
      startBtn.className = 'btn btn-start';
      startBtn.textContent = done > 0 ? 'Restart in clean cluster' : 'Start in clean cluster';
      startBtn.addEventListener('click', () => startLesson(lesson.id));
      actions.appendChild(startBtn);
      body.appendChild(actions);

      wrapEl.appendChild(body);
      lessonsEl.appendChild(wrapEl);
    });

    lessonProgressEl.textContent = completed + '/' + LESSONS.length + ' complete';
  }

  /* ---------- labs panel ---------- */

  function renderLabs() {
    labsEl.innerHTML = '';
    let solved = 0;
    const drillId = active && active.kind === 'lab' && active.drill ? active.id : null;

    if (drillId) {
      const lab = LABS.find(l => l.id === drillId);
      const metCount = lab.goals.filter(g => g.done(engine)).length;

      const wrapEl = document.createElement('div');
      wrapEl.className = 'lab active drill-mystery open';

      const head = document.createElement('div');
      head.className = 'lab-head';
      head.innerHTML =
        '<span class="lab-diff diff-drill">DRILL</span>' +
        '<span class="lab-title">Unidentified fault</span>' +
        '<span class="lab-check">active</span>';
      wrapEl.appendChild(head);

      const body = document.createElement('div');
      body.className = 'lab-body';

      const brief = document.createElement('p');
      brief.className = 'lab-briefing';
      brief.textContent = 'Something is wrong with this cluster. Find it and fix it — details stay hidden until you solve it or reveal it.';
      body.appendChild(brief);

      const goals = document.createElement('div');
      goals.className = 'lab-goals';
      const goalEl = document.createElement('div');
      goalEl.className = 'goal' + (metCount === lab.goals.length ? ' done' : '');
      goalEl.innerHTML = '<span class="goal-box">' + (metCount === lab.goals.length ? '✔' : '▢') + '</span>';
      const gt = document.createElement('span');
      gt.textContent = metCount + ' / ' + lab.goals.length + ' goals met';
      goalEl.appendChild(gt);
      goals.appendChild(goalEl);
      body.appendChild(goals);

      const actions = document.createElement('div');
      actions.className = 'scenario-actions';
      const revealBtn = document.createElement('button');
      revealBtn.className = 'btn btn-hint';
      revealBtn.textContent = 'Reveal';
      revealBtn.addEventListener('click', () => revealDrill(drillId));
      actions.appendChild(revealBtn);
      body.appendChild(actions);

      wrapEl.appendChild(body);
      labsEl.appendChild(wrapEl);
    }

    LABS.forEach(lab => {
      if (lab.id === drillId) return; // shown as the mystery card above instead
      const isActive = active && active.kind === 'lab' && active.id === lab.id && !active.drill;
      const done = labSolved(lab.id);
      if (done) solved++;

      const wrapEl = document.createElement('div');
      wrapEl.className = 'lab' +
        (openLabs.has(lab.id) ? ' open' : '') +
        (isActive ? ' active' : '') +
        (done ? ' solved' : '');

      const head = document.createElement('button');
      head.className = 'lab-head';
      head.setAttribute('aria-expanded', openLabs.has(lab.id));
      const diff = lab.difficulty.toLowerCase();
      head.innerHTML =
        '<span class="lab-diff diff-' + diff + '">' + lab.difficulty + '</span>' +
        '<span class="lab-title">' + lab.title + '</span>' +
        '<span class="lab-check">' + (done ? '✔ solved' : (isActive ? 'active' : '')) + '</span>';
      head.addEventListener('click', () => {
        if (openLabs.has(lab.id)) openLabs.delete(lab.id);
        else openLabs.add(lab.id);
        renderLabs();
      });
      wrapEl.appendChild(head);

      const body = document.createElement('div');
      body.className = 'lab-body';

      const brief = document.createElement('p');
      brief.className = 'lab-briefing';
      brief.textContent = lab.briefing;
      body.appendChild(brief);

      const goals = document.createElement('div');
      goals.className = 'lab-goals';
      lab.goals.forEach(g => {
        const met = done || (isActive && g.done(engine));
        const goalEl = document.createElement('div');
        goalEl.className = 'goal' + (met ? ' done' : '');
        goalEl.innerHTML = '<span class="goal-box">' + (met ? '✔' : '▢') + '</span>';
        const gt = document.createElement('span');
        gt.textContent = g.text;
        goalEl.appendChild(gt);
        goals.appendChild(goalEl);
      });
      body.appendChild(goals);

      const actions = document.createElement('div');
      actions.className = 'scenario-actions';
      const startBtn = document.createElement('button');
      startBtn.className = 'btn btn-start';
      startBtn.textContent = isActive ? 'Restart lab' : 'Start lab';
      startBtn.addEventListener('click', () => startLab(lab.id));
      actions.appendChild(startBtn);

      if (lab.hints && lab.hints.length) {
        const hintBtn = document.createElement('button');
        hintBtn.className = 'btn btn-hint';
        hintBtn.textContent = 'Hint';
        hintBtn.addEventListener('click', () => {
          labHintsShown[lab.id] = Math.min((labHintsShown[lab.id] || 0) + 1, lab.hints.length);
          renderLabs();
        });
        actions.appendChild(hintBtn);
      }
      body.appendChild(actions);

      const shown = labHintsShown[lab.id] || 0;
      if (shown) {
        const hints = document.createElement('ol');
        hints.className = 'lab-hints';
        for (let i = 0; i < shown; i++) {
          const li = document.createElement('li');
          li.textContent = lab.hints[i];
          hints.appendChild(li);
        }
        body.appendChild(hints);
      }

      wrapEl.appendChild(body);
      labsEl.appendChild(wrapEl);
    });

    labProgressEl.textContent = solved + '/' + LABS.length + ' solved';
  }

  function renderAll() {
    renderPrompt();
    renderRack();
    renderChips();
    renderLessons();
    renderLabs();
  }

  /* ---------- reset buttons ---------- */

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (active && active.kind === 'lab') {
      if (!confirm('Restart this ' + (active.drill ? 'drill' : 'lab') + ' from its starting state?')) return;
      startLab(active.id, { drill: !!active.drill });
      return;
    }
    if (active && active.kind === 'lesson' && lessonSteps(active.id) > 0) {
      if (!confirm('Reset the cluster to this lesson’s starting state?')) return;
      startLesson(active.id);
      return;
    }
    if (!confirm('Reset the simulated cluster to its initial state? Progress is kept.')) return;
    loadFixture(null);
    outEl.innerHTML = '';
    banner();
    renderAll();
    inputEl.focus();
  });

  document.getElementById('btn-reset-progress').addEventListener('click', () => {
    if (!confirm('Clear all lesson and lab progress? The cluster is left as-is.')) return;
    progress = { lessons: {}, labs: {}, active: active };
    saveProgress();
    renderLessons();
    renderLabs();
  });

  document.getElementById('btn-drill').addEventListener('click', startDrill);

  /* ---------- boot ---------- */

  // Try to resume exactly where the active scenario left off. Without this,
  // a reload would keep the "active lesson/lab" label but silently hand back
  // a fresh, healthy base cluster — see the module comment above onEvent.
  let restoredFromSnapshot = false;
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    const saved = raw && JSON.parse(raw);
    if (saved && saved.scenario && saved.scenario.kind === active.kind && saved.scenario.id === active.id) {
      active = saved.scenario;
      progress.active = active;
      if (active.kind === 'lab' && !active.drill) openLabs.add(active.id);
      loading = true;
      engine.restoreSnapshot(saved.snap);
      loading = false;
      restoredFromSnapshot = true;
    }
  } catch (e) { /* corrupt snapshot; fall through to a fresh fixture */ }

  if (restoredFromSnapshot) {
    banner();
    const found = active.kind === 'lab' ? LABS.find(l => l.id === active.id) : LESSONS.find(l => l.id === active.id);
    const label = active.kind === 'lab' && active.drill ? 'a troubleshooting drill' : (found && found.title);
    if (label) appendLines([{ text: 'Resumed where you left off: ' + label + '.', cls: 'muted' }, { text: '' }]);
    renderAll();
    scrollTerm();
  } else if (active.kind === 'lab') {
    startLab(active.id, { drill: !!active.drill });
  } else {
    startLesson(active.id);
  }
  inputEl.focus();

  // Deep links:
  //   ?scenario=<lesson-or-lab-id>  jump straight into one isolated scenario
  //   ?drill=1                      start a random troubleshooting drill
  //   ?play=cmd;cmd;...             pre-type a sequence of commands
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario');
  if (scenario) {
    if (LABS.some(l => l.id === scenario)) startLab(scenario);
    else if (LESSONS.some(l => l.id === scenario)) startLesson(scenario);
  } else if (params.get('drill')) {
    startDrill();
  }
  const play = params.get('play');
  if (play) {
    for (const c of play.split(';')) {
      if (c.trim()) runCommand(c.trim());
    }
  }
})();
