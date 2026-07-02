/* UI wiring: terminal, rack elevation, lessons panel. */

(function () {
  'use strict';

  const termEl = document.getElementById('term');
  const outEl = document.getElementById('term-out');
  const promptEl = document.getElementById('term-prompt');
  const inputEl = document.getElementById('term-input');
  const rackEl = document.getElementById('rack');
  const lessonsEl = document.getElementById('lessons');
  const lessonProgressEl = document.getElementById('lesson-progress');
  const nodesUpEl = document.getElementById('nodes-up');
  const chipModifiedEl = document.getElementById('chip-modified');

  const STORAGE_KEY = 'bcm-cmsh-trainer-progress';

  /* ---------- lesson progress ---------- */

  let progress = {};
  try { progress = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { progress = {}; }
  let activeLessonId = progress.__active || CmshLessons.LESSONS[0].id;
  const openLessons = new Set([activeLessonId]);

  function saveProgress() {
    progress.__active = activeLessonId;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch (e) { /* private mode */ }
  }

  function stepsDone(lessonId) { return progress[lessonId] || 0; }

  /* ---------- engine ---------- */

  const engine = new Cmsh.CmshEngine({
    makeInitialState: CmshState.makeInitialState,
    onEvent: lines => { appendLines(lines); scrollTerm(); },
    onStateChange: () => { renderRack(); renderChips(); renderPrompt(); },
  });

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
      { text: 'Type "help" to explore, or pick a lesson on the right.', cls: 'muted' },
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
    if (cmd) {
      history.push(cmd);
      const output = engine.execute(cmd);
      appendLines(output);
      checkLessons(cmd, output.map(l => l.text).join('\n'));
    }
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
      // Extend to the longest common prefix; if stuck, show the candidates.
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

  /* ---------- lessons ---------- */

  function checkLessons(cmd, outputText) {
    const lesson = CmshLessons.LESSONS.find(l => l.id === activeLessonId);
    if (!lesson) return;
    let done = stepsDone(lesson.id);
    const ctx = { engine, cmd, output: outputText };
    let advanced = false;
    while (done < lesson.steps.length && lesson.steps[done].check(ctx)) {
      done++;
      advanced = true;
    }
    if (advanced) {
      progress[lesson.id] = done;
      saveProgress();
      renderLessons();
      if (done === lesson.steps.length) {
        appendLines([{ text: '✔ Lesson complete: ' + lesson.title, cls: 'ok' }]);
        scrollTerm();
      }
    }
  }

  function renderLessons() {
    lessonsEl.innerHTML = '';
    let completed = 0;

    CmshLessons.LESSONS.forEach((lesson, li) => {
      const done = stepsDone(lesson.id);
      const isDone = done >= lesson.steps.length;
      if (isDone) completed++;

      const wrap = document.createElement('div');
      wrap.className = 'lesson' +
        (openLessons.has(lesson.id) ? ' open' : '') +
        (lesson.id === activeLessonId ? ' active' : '') +
        (isDone ? ' done' : '');

      const head = document.createElement('button');
      head.className = 'lesson-head';
      head.setAttribute('aria-expanded', openLessons.has(lesson.id));
      head.innerHTML =
        '<span class="lesson-num">' + (li + 1) + '</span>' +
        '<span>' + lesson.title + '</span>' +
        '<span class="lesson-check">' + (isDone ? '✔ done' : done + '/' + lesson.steps.length) + '</span>';
      head.addEventListener('click', () => {
        if (openLessons.has(lesson.id)) openLessons.delete(lesson.id);
        else openLessons.add(lesson.id);
        activeLessonId = lesson.id;
        saveProgress();
        renderLessons();
        inputEl.focus();
      });
      wrap.appendChild(head);

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

        if (si === done && lesson.id === activeLessonId) {
          const hintBtn = document.createElement('button');
          hintBtn.className = 'step-hint';
          hintBtn.textContent = 'show hint';
          hintBtn.addEventListener('click', () => {
            const cmdEl = document.createElement('span');
            cmdEl.className = 'step-hint-cmd';
            cmdEl.textContent = '% ' + step.hint;
            cmdEl.title = 'Click to type this into the terminal';
            cmdEl.style.cursor = 'pointer';
            cmdEl.addEventListener('click', () => {
              inputEl.value = step.hint;
              inputEl.focus();
            });
            hintBtn.replaceWith(cmdEl);
          });
          txt.appendChild(hintBtn);
        }

        stepEl.appendChild(txt);
        body.appendChild(stepEl);
      });

      wrap.appendChild(body);
      lessonsEl.appendChild(wrap);
    });

    lessonProgressEl.textContent = completed + '/' + CmshLessons.LESSONS.length + ' complete';
  }

  /* ---------- reset ---------- */

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (!confirm('Reset the simulated cluster to its initial state? Lesson progress is kept.')) return;
    engine.reset();
    outEl.innerHTML = '';
    banner();
    renderPrompt();
    renderRack();
    renderChips();
    inputEl.focus();
  });

  /* ---------- boot ---------- */

  banner();
  renderPrompt();
  renderRack();
  renderChips();
  renderLessons();
  inputEl.focus();

  // Deep-link a pre-typed session: ?play=device;ls;power%20off%20-n%20node002
  const play = new URLSearchParams(location.search).get('play');
  if (play) {
    for (const c of play.split(';')) {
      if (c.trim()) runCommand(c.trim());
    }
  }
})();
