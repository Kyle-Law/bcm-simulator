/* cmsh simulator engine.
 * Interprets a practical subset of NVIDIA Base Command Manager's cmsh:
 * mode navigation, ls/use/show/get/set/clear, staged changes with
 * commit/refresh/modified, add/clone/remove, and device power/status. */

(function (global) {
  'use strict';

  const MODES = {
    device: {
      store: 'devices',
      label: 'Devices',
      desc: 'Device management (nodes, switches)',
      props: ['category', 'hostname', 'ip', 'mac', 'network', 'powercontrol', 'revision'],
    },
    category: {
      store: 'categories',
      label: 'Categories',
      desc: 'Node category settings',
      props: ['defaultgateway', 'installmode', 'name', 'newnodeinstallmode', 'revision', 'softwareimage'],
    },
    softwareimage: {
      store: 'softwareimages',
      label: 'Software Images',
      desc: 'Software image management',
      props: ['kernelversion', 'name', 'path', 'revision'],
    },
    network: {
      store: 'networks',
      label: 'Networks',
      desc: 'Network configuration',
      props: ['baseaddress', 'domainname', 'mtu', 'name', 'netmaskbits', 'revision'],
    },
    partition: {
      store: 'partitions',
      label: 'Partitions',
      desc: 'Cluster-wide settings (partition base)',
      props: ['administratoremail', 'clustername', 'defaultcategory', 'name', 'nameservers', 'revision', 'timeservers', 'timezone'],
    },
    user: {
      store: 'users',
      label: 'Users',
      desc: 'User management',
      props: ['email', 'homedirectory', 'name', 'password', 'revision', 'shell', 'uid'],
    },
  };

  const GLOBAL_COMMANDS = ['ls', 'list', 'use', 'show', 'get', 'set', 'clear', 'commit',
    'refresh', 'modified', 'add', 'remove', 'clone', 'events', 'help', 'exit', 'home', 'quit', '..'];
  const DEVICE_COMMANDS = ['status', 'power', 'sysinfo', 'latestmetricdata', 'reboot', 'imageupdate'];

  const ZERO_MAC = '00:00:00:00:00:00';

  const POWER_OPS = ['status', 'on', 'off', 'reset'];

  function line(text, cls) { return { text, cls: cls || '' }; }
  function err(text) { return line(text, 'err'); }

  function pad(s, w) {
    s = String(s);
    return s.length >= w ? s : s + ' '.repeat(w - s.length);
  }

  /* Render an aligned table with a dashed separator under the header. */
  function table(headers, rows) {
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map(r => String(r[i]).length), 1));
    const out = [];
    out.push(line(widths.map((w, i) => pad(headers[i], w)).join('  ')));
    out.push(line(widths.map(w => '-'.repeat(w)).join('  '), 'muted'));
    for (const r of rows) {
      out.push(line(widths.map((w, i) => pad(r[i], w)).join('  ')));
    }
    return out;
  }

  function eventTimestamp() {
    const d = new Date();
    return d.toDateString().slice(0, 10) + ' ' + d.toTimeString().slice(0, 8) + ' ' + d.getFullYear();
  }

  function dotted(name, width) {
    return name + ' ' + '.'.repeat(Math.max(3, width - name.length - 1));
  }

  /* Expand "node001..node004" and comma-separated lists into node names. */
  function expandNodeSpec(spec) {
    const out = [];
    for (const part of spec.split(',')) {
      const m = part.match(/^([a-z-]+)(\d+)\.\.(?:[a-z-]+)?(\d+)$/i);
      if (m) {
        const prefix = m[1];
        const width = m[2].length;
        const lo = parseInt(m[2], 10), hi = parseInt(m[3], 10);
        for (let i = lo; i <= hi; i++) out.push(prefix + String(i).padStart(width, '0'));
      } else if (part) {
        out.push(part);
      }
    }
    return out;
  }

  class CmshEngine {
    constructor(opts) {
      opts = opts || {};
      this.makeState = opts.makeInitialState;
      this.state = this.makeState();
      this.onEvent = opts.onEvent || function () {};
      this.onStateChange = opts.onStateChange || function () {};
      this.timers = [];
      this.eventLog = [];
      this.currentSetup = null;
      this.resetSession();
    }

    resetSession() {
      this.session = { mode: null, object: null, staged: {} };
    }

    /* Rebuild the cluster. An optional setup(state, engine) mutates the fresh
     * state (and may stage session changes) to produce a scenario fixture. */
    reset(setup) {
      for (const t of this.timers) clearTimeout(t);
      this.timers = [];
      this.state = this.makeState();
      this.resetSession();
      this.eventLog = [];
      this.currentSetup = setup || null;
      if (setup) setup(this.state, this);
      this.onStateChange();
    }

    schedule(fn, ms) {
      const t = setTimeout(() => {
        this.timers = this.timers.filter(x => x !== t);
        fn();
      }, ms);
      this.timers.push(t);
    }

    emitEvent(text, severity) {
      severity = severity || 'notice';
      const stamp = eventTimestamp();
      this.eventLog.push({ stamp, severity, text });
      if (this.eventLog.length > 100) this.eventLog.shift();
      this.onEvent([line(stamp + ' [' + severity + '] ' +
        this.state.cluster + ': ' + text, 'event')]);
      this.onStateChange();
    }

    /* ---------- staging helpers ---------- */

    stageKey(mode, name) { return mode + ':' + name; }

    getStaged(mode, name) { return this.session.staged[this.stageKey(mode, name)]; }

    ensureStaged(mode, name, isNew) {
      const k = this.stageKey(mode, name);
      if (!this.session.staged[k]) {
        this.session.staged[k] = { mode, name, props: {}, isNew: !!isNew, removed: false };
      }
      return this.session.staged[k];
    }

    /* All object names visible in a mode: committed plus staged-new, minus staged-removed. */
    objectNames(mode) {
      const store = this.state[MODES[mode].store];
      const names = new Set(Object.keys(store));
      for (const k in this.session.staged) {
        const s = this.session.staged[k];
        if (s.mode !== mode) continue;
        if (s.isNew && !s.removed) names.add(s.name);
        if (s.removed) names.delete(s.name);
      }
      return [...names].sort();
    }

    /* Committed object merged with staged edits. */
    effective(mode, name) {
      const store = this.state[MODES[mode].store];
      const staged = this.getStaged(mode, name);
      if (staged && staged.removed) return null;
      const base = store[name];
      if (!base && !(staged && staged.isNew)) return null;
      return Object.assign({}, base || {}, staged ? staged.props : {});
    }

    isModified(mode, name) {
      const s = this.getStaged(mode, name);
      return !!(s && (s.isNew || s.removed || Object.keys(s.props).length));
    }

    modeModified(mode) {
      return Object.values(this.session.staged).some(s =>
        s.mode === mode && (s.isNew || s.removed || Object.keys(s.props).length));
    }

    /* ---------- prompt ---------- */

    prompt() {
      const s = this.session;
      let p = '[' + this.state.cluster;
      if (s.mode) {
        p += '->' + s.mode + (this.modeModified(s.mode) ? '*' : '');
        if (s.object) {
          p += '[' + s.object + (this.isModified(s.mode, s.object) ? '*' : '') + ']';
        }
      }
      return p + ']% ';
    }

    /* ---------- execution ---------- */

    execute(input) {
      const out = [];
      for (const part of input.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        out.push(...this.executeOne(trimmed));
      }
      this.onStateChange();
      return out;
    }

    executeOne(input) {
      const tokens = input.split(/\s+/);
      const cmd = tokens[0];
      const args = tokens.slice(1);
      const s = this.session;

      // Mode switching from the top level (or between modes).
      if (MODES[cmd]) {
        s.mode = cmd;
        s.object = null;
        if (cmd === 'partition') {
          // partition has a single object; cmsh users immediately `use base`.
          return [];
        }
        return [];
      }
      if (cmd === 'main') { s.mode = null; s.object = null; return []; }

      switch (cmd) {
        case 'help': return this.cmdHelp(args);
        case 'quit': return this.cmdQuit();
        case 'exit': case '..': return this.cmdExit();
        case 'home': s.mode = null; s.object = null; return [];
        case 'ls': case 'list': return this.cmdList();
        case 'use': return this.cmdUse(args);
        case 'show': return this.cmdShow(args);
        case 'get': return this.cmdGet(args);
        case 'set': return this.cmdSet(args);
        case 'clear': return this.cmdClear(args);
        case 'commit': return this.cmdCommit();
        case 'refresh': return this.cmdRefresh();
        case 'modified': return this.cmdModified();
        case 'add': return this.cmdAdd(args);
        case 'remove': return this.cmdRemove(args);
        case 'clone': return this.cmdClone(args);
        case 'events': return this.cmdEvents(args);
      }

      if (s.mode === 'device') {
        switch (cmd) {
          case 'status': return this.cmdStatus(args);
          case 'power': return this.cmdPower(args);
          case 'reboot': return this.cmdPower(['reset'].concat(args));
          case 'sysinfo': return this.cmdSysinfo(args);
          case 'latestmetricdata': return this.cmdMetrics(args);
          case 'imageupdate': return this.cmdImageUpdate(args);
        }
      }

      return [err(cmd + ': command not found (type "help" for available commands)')];
    }

    requireMode() {
      if (!this.session.mode) {
        return [err('This command must be run from within a mode (e.g. "device"). Type "help".')];
      }
      return null;
    }

    /* Resolve an optional leading object-name argument, falling back to the
     * currently used object. Returns { name, rest, error }. */
    resolveTarget(args) {
      const mode = this.session.mode;
      if (args.length && this.objectNames(mode).includes(args[0])) {
        return { name: args[0], rest: args.slice(1) };
      }
      if (this.session.object) return { name: this.session.object, rest: args };
      if (args.length) {
        return { error: [err('No object named "' + args[0] + '" in ' + mode + ' mode')] };
      }
      return { error: [err('No object in use (try "use <name>" first)')] };
    }

    /* ---------- commands ---------- */

    cmdHelp() {
      const out = [];
      const s = this.session;
      if (!s.mode) {
        out.push(line('Available modes:', 'muted'));
        for (const m in MODES) out.push(line('  ' + pad(m, 16) + MODES[m].desc));
        out.push(line(''));
        out.push(line('Global commands:', 'muted'));
        out.push(line('  ' + pad('help', 16) + 'Show this help'));
        out.push(line('  ' + pad('<mode>', 16) + 'Enter a mode (e.g. "device")'));
        out.push(line('  ' + pad('modified', 16) + 'List objects with uncommitted changes'));
        out.push(line('  ' + pad('commit', 16) + 'Commit all pending changes'));
        out.push(line('  ' + pad('refresh', 16) + 'Discard all pending changes'));
        out.push(line('  ' + pad('events [n]', 16) + 'Show the last n cluster events'));
        out.push(line('  ' + pad('quit', 16) + 'End the cmsh session'));
        return out;
      }
      out.push(line('Commands in ' + s.mode + ' mode:', 'muted'));
      const rows = [
        ['ls / list', 'List objects in this mode'],
        ['use <name>', 'Select an object to work on'],
        ['show [name]', 'Show all properties of an object'],
        ['get <prop>', 'Get a property value'],
        ['set <prop> <value>', 'Set a property (staged until commit)'],
        ['clear <prop>', 'Clear a property'],
        ['add <name>', 'Add a new object'],
        ['clone <src> <dst>', 'Clone an object'],
        ['remove <name>', 'Remove an object (staged until commit)'],
        ['commit', 'Save pending changes'],
        ['refresh', 'Discard pending changes'],
        ['modified', 'List uncommitted objects'],
        ['events [n]', 'Show the last n cluster events'],
        ['exit / ..', 'Go up one level'],
        ['home', 'Return to the top level'],
      ];
      if (s.mode === 'device') {
        rows.push(
          ['status', 'Show device status'],
          ['power <op> [-n <nodes>]', 'Power status/on/off/reset'],
          ['reboot [-n <nodes>]', 'Reboot nodes'],
          ['sysinfo [name]', 'Show system information'],
          ['latestmetricdata [name]', 'Show latest monitoring metrics'],
          ['imageupdate [-w] [-n <nodes>]', 'Sync software image to running nodes (dry run without -w)'],
        );
      }
      out.push(line(''));
      for (const [c, d] of rows) out.push(line('  ' + pad(c, 26) + d));
      out.push(line(''));
      out.push(line('Properties: ' + MODES[s.mode].props.join(', '), 'muted'));
      return out;
    }

    cmdQuit() {
      this.resetSession();
      return [line('Connection to cluster closed. Starting a new session.', 'muted')];
    }

    cmdExit() {
      const s = this.session;
      if (s.object) s.object = null;
      else if (s.mode) s.mode = null;
      return [];
    }

    cmdList() {
      const bad = this.requireMode();
      if (bad) return bad;
      const mode = this.session.mode;
      const names = this.objectNames(mode);
      const star = n => this.isModified(mode, n) ? n + '*' : n;

      if (mode === 'device') {
        return table(
          ['Type', 'Hostname (key)', 'MAC', 'Category', 'IP', 'Network', 'Status'],
          names.map(n => {
            const d = this.effective('device', n);
            return [d.type, star(n), d.mac, d.category, d.ip, d.network, '[ ' + d.status + ' ]'];
          }));
      }
      if (mode === 'category') {
        const nodeCount = c => Object.keys(this.state.devices)
          .filter(n => (this.effective('device', n) || {}).category === c).length;
        return table(['Name (key)', 'Software image', 'Nodes'],
          names.map(n => {
            const c = this.effective('category', n);
            return [star(n), c.softwareimage, nodeCount(n)];
          }));
      }
      if (mode === 'softwareimage') {
        return table(['Name (key)', 'Path', 'Kernel version'],
          names.map(n => {
            const i = this.effective('softwareimage', n);
            return [star(n), i.path, i.kernelversion];
          }));
      }
      if (mode === 'network') {
        return table(['Name (key)', 'Type', 'Base address', 'Netmask bits', 'Domain name'],
          names.map(n => {
            const w = this.effective('network', n);
            return [star(n), w.type, w.baseaddress, w.netmaskbits, w.domainname];
          }));
      }
      if (mode === 'partition') {
        return table(['Name (key)', 'Cluster name', 'Default category'],
          names.map(n => {
            const p = this.effective('partition', n);
            return [star(n), p.clustername, p.defaultcategory];
          }));
      }
      if (mode === 'user') {
        if (!names.length) return [line('No users defined. Use "add <name>" to create one.', 'muted')];
        return table(['Name (key)', 'UID', 'Home directory', 'Shell'],
          names.map(n => {
            const u = this.effective('user', n);
            return [star(n), u.uid, u.homedirectory, u.shell];
          }));
      }
      return [];
    }

    cmdUse(args) {
      const bad = this.requireMode();
      if (bad) return bad;
      if (!args.length) return [err('use: object name required')];
      const mode = this.session.mode;
      if (!this.objectNames(mode).includes(args[0])) {
        return [err('No object named "' + args[0] + '" in ' + mode + ' mode')];
      }
      this.session.object = args[0];
      return [];
    }

    cmdShow(args) {
      const bad = this.requireMode();
      if (bad) return bad;
      const mode = this.session.mode;
      const t = this.resolveTarget(args);
      if (t.error) return t.error;
      const o = this.effective(mode, t.name);
      const rows = [];
      const label = p => p.charAt(0).toUpperCase() + p.slice(1)
        .replace('softwareimage', 'oftware image').replace('image', 'image')
        .replace(/^(.)/, c => c);

      // Friendly labels for the property sheet.
      const LABELS = {
        hostname: 'Hostname', category: 'Category', ip: 'IP', mac: 'MAC',
        network: 'Network', powercontrol: 'Power control', revision: 'Revision',
        softwareimage: 'Software image', defaultgateway: 'Default gateway',
        installmode: 'Install mode', newnodeinstallmode: 'New node install mode',
        name: 'Name', path: 'Path', kernelversion: 'Kernel version',
        baseaddress: 'Base address', domainname: 'Domain name', mtu: 'MTU',
        netmaskbits: 'Netmask bits', clustername: 'Cluster name',
        administratoremail: 'Administrator e-mail', timeservers: 'Time servers',
        nameservers: 'Name servers', timezone: 'Time zone',
        defaultcategory: 'Default category', uid: 'UID',
        homedirectory: 'Home directory', shell: 'Shell', email: 'E-mail',
        password: 'Password',
      };

      for (const p of MODES[mode].props) {
        rows.push([LABELS[p] || label(p), o[p] !== undefined && o[p] !== '' ? o[p] : '']);
      }
      if (mode === 'device') {
        const cat = o.category && this.effective('category', o.category);
        rows.push(['Software image', cat ? cat.softwareimage + ' (from category)' : '']);
        rows.push(['Partition', 'base']);
        rows.push(['Status', '[ ' + o.status + ' ]']);
        rows.push(['Type', o.type]);
      }
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      return table(['Parameter', 'Value'], rows);
    }

    cmdGet(args) {
      const bad = this.requireMode();
      if (bad) return bad;
      const mode = this.session.mode;
      const t = this.resolveTarget(args);
      if (t.error) return t.error;
      if (!t.rest.length) return [err('get: property name required')];
      const prop = t.rest[0].toLowerCase();
      if (!MODES[mode].props.includes(prop)) {
        return [err('get: no such property: ' + prop)];
      }
      const o = this.effective(mode, t.name);
      return [line(String(o[prop] !== undefined ? o[prop] : ''))];
    }

    cmdSet(args) {
      const bad = this.requireMode();
      if (bad) return bad;
      const mode = this.session.mode;
      const t = this.resolveTarget(args);
      if (t.error) return t.error;
      if (t.rest.length < 1) return [err('set: property name required')];
      const prop = t.rest[0].toLowerCase();
      let value = t.rest.slice(1).join(' ');
      // Strip a matching pair of surrounding quotes, like a real shell would.
      if (value.length >= 2 && /^"[^]*"$|^'[^]*'$/.test(value)) value = value.slice(1, -1);
      if (!MODES[mode].props.includes(prop)) {
        return [err('set: no such property: ' + prop)];
      }
      if (!t.rest.slice(1).length) {
        if (prop === 'password') {
          return [err('set password: provide the password on the line in this simulator, e.g. "set password Ch4ngeMe!"')];
        }
        return [err('set: value required')];
      }
      // Referential checks that real cmsh enforces at commit time.
      if (mode === 'device' && prop === 'category' && !this.objectNames('category').includes(value)) {
        return [err('set: no category named "' + value + '" (clone or add one in category mode first)')];
      }
      if (mode === 'category' && prop === 'softwareimage' && !this.objectNames('softwareimage').includes(value)) {
        return [err('set: no software image named "' + value + '"')];
      }
      const staged = this.ensureStaged(mode, t.name);
      staged.props[prop] = prop === 'password' ? '*********' : value;
      return [];
    }

    cmdClear(args) {
      const bad = this.requireMode();
      if (bad) return bad;
      const mode = this.session.mode;
      const t = this.resolveTarget(args);
      if (t.error) return t.error;
      if (!t.rest.length) return [err('clear: property name required')];
      const prop = t.rest[0].toLowerCase();
      if (!MODES[mode].props.includes(prop)) {
        return [err('clear: no such property: ' + prop)];
      }
      this.ensureStaged(mode, t.name).props[prop] = '';
      return [];
    }

    cmdModified() {
      const rows = [];
      for (const k in this.session.staged) {
        const s = this.session.staged[k];
        if (!(s.isNew || s.removed || Object.keys(s.props).length)) continue;
        if (this.session.mode && s.mode !== this.session.mode) continue;
        const state = s.removed ? 'Removed' : s.isNew ? 'New' : 'Modified';
        rows.push([MODES[s.mode].label.replace(/s$/, '').replace('Categorie', 'Category'), s.name, state]);
      }
      if (!rows.length) return [line('No modified objects.', 'muted')];
      return table(['Type', 'Name', 'State'], rows);
    }

    cmdCommit() {
      const s = this.session;
      const scope = Object.values(this.session.staged).filter(x => {
        if (!(x.isNew || x.removed || Object.keys(x.props).length)) return false;
        if (s.mode && x.mode !== s.mode) return false;
        if (s.mode && s.object && x.name !== s.object) return false;
        return true;
      });
      if (!scope.length) return [line('Nothing to commit.', 'muted')];

      const counts = {};
      for (const x of scope) {
        const store = this.state[MODES[x.mode].store];
        if (x.removed) {
          delete store[x.name];
        } else {
          if (!store[x.name]) store[x.name] = {};
          Object.assign(store[x.name], x.props);
          if (x.isNew) this.afterCreate(x.mode, x.name);
        }
        counts[x.mode] = (counts[x.mode] || 0) + 1;
        delete this.session.staged[this.stageKey(x.mode, x.name)];
      }
      const out = [];
      for (const m in counts) {
        out.push(line('Successfully committed ' + counts[m] + ' ' + MODES[m].label, 'ok'));
      }
      return out;
    }

    /* Post-commit side effects for newly created objects. */
    afterCreate(mode, name) {
      if (mode === 'softwareimage') {
        this.emitEvent('Initial ramdisk generation for image ' + name + ' started');
        this.schedule(() => {
          this.emitEvent('Initial ramdisk for image ' + name + ' was generated successfully');
        }, 3500);
      }
    }

    cmdRefresh() {
      const s = this.session;
      let n = 0;
      for (const k of Object.keys(this.session.staged)) {
        const x = this.session.staged[k];
        if (s.mode && x.mode !== s.mode) continue;
        if (s.mode && s.object && x.name !== s.object) continue;
        delete this.session.staged[k];
        n++;
        if (x.isNew && s.object === x.name) s.object = null;
      }
      return n ? [line('Discarded pending changes.', 'muted')] : [line('Nothing to refresh.', 'muted')];
    }

    cmdAdd(args) {
      const bad = this.requireMode();
      if (bad) return bad;
      const mode = this.session.mode;

      if (mode === 'device') {
        // add physicalnode <name> [ip]
        if (args[0] !== 'physicalnode' || !args[1]) {
          return [err('usage in device mode: add physicalnode <hostname> [ip]')];
        }
        const name = args[1];
        if (this.objectNames('device').includes(name)) return [err('add: "' + name + '" already exists')];
        const used = this.objectNames('device').map(n => this.effective('device', n).ip);
        let ip = args[2];
        if (!ip) {
          for (let i = 1; i < 250; i++) {
            if (!used.includes('10.141.0.' + i)) { ip = '10.141.0.' + i; break; }
          }
        }
        const staged = this.ensureStaged('device', name, true);
        staged.props = {
          type: 'PhysicalNode', hostname: name, category: 'default',
          mac: ZERO_MAC, ip, network: 'internalnet',
          powercontrol: 'ipmi0', revision: '', status: 'DOWN', power: 'off',
          provisioned: false,
        };
        this.session.object = name;
        return [];
      }

      if (!args.length) return [err('add: name required')];
      const name = args[0];
      if (this.objectNames(mode).includes(name)) return [err('add: "' + name + '" already exists')];
      const staged = this.ensureStaged(mode, name, true);
      if (mode === 'user') {
        staged.props = {
          name, uid: this.state.nextuid++, homedirectory: '/home/' + name,
          shell: '/bin/bash', email: '', password: '', revision: '',
        };
      } else if (mode === 'category') {
        staged.props = Object.assign({}, this.state.categories['default'], { name });
      } else if (mode === 'network') {
        staged.props = { name, type: 'Internal', baseaddress: '0.0.0.0', netmaskbits: '16', domainname: '', mtu: '1500', revision: '' };
      } else if (mode === 'softwareimage') {
        staged.props = { name, path: '/cm/images/' + name, kernelversion: this.state.softwareimages['default-image'].kernelversion, revision: '' };
      } else {
        return [err('add: not supported in ' + mode + ' mode in this simulator')];
      }
      this.session.object = name;
      return [];
    }

    cmdRemove(args) {
      const bad = this.requireMode();
      if (bad) return bad;
      const mode = this.session.mode;
      const name = args[0] || this.session.object;
      if (!name) return [err('remove: name required')];
      if (!this.objectNames(mode).includes(name)) {
        return [err('No object named "' + name + '" in ' + mode + ' mode')];
      }
      if (mode === 'device' && this.effective('device', name).type === 'HeadNode') {
        return [err('remove: refusing to remove the head node')];
      }
      if (mode === 'category' && name === 'default') {
        return [err('remove: category "default" is in use by nodes')];
      }
      const staged = this.ensureStaged(mode, name);
      if (staged.isNew) {
        delete this.session.staged[this.stageKey(mode, name)];
      } else {
        staged.removed = true;
        staged.props = {};
      }
      if (this.session.object === name) this.session.object = null;
      return [];
    }

    cmdClone(args) {
      const bad = this.requireMode();
      if (bad) return bad;
      const mode = this.session.mode;
      if (args.length < 2) return [err('usage: clone <source> <destination>')];
      const [src, dst] = args;
      const srcObj = this.effective(mode, src);
      if (!srcObj) return [err('No object named "' + src + '" in ' + mode + ' mode')];
      if (this.objectNames(mode).includes(dst)) return [err('clone: "' + dst + '" already exists')];
      const staged = this.ensureStaged(mode, dst, true);
      staged.props = Object.assign({}, srcObj);
      if ('name' in staged.props) staged.props.name = dst;
      if ('hostname' in staged.props) staged.props.hostname = dst;
      if (mode === 'softwareimage') staged.props.path = '/cm/images/' + dst;
      this.session.object = dst;
      return [];
    }

    /* ---------- device mode extras ---------- */

    powerTargets(args) {
      const nIdx = args.indexOf('-n');
      if (nIdx !== -1 && args[nIdx + 1]) {
        const names = expandNodeSpec(args[nIdx + 1]);
        const missing = names.filter(n => !this.objectNames('device').includes(n));
        if (missing.length) return { error: [err('No device named "' + missing[0] + '"')] };
        return { names };
      }
      if (this.session.object) return { names: [this.session.object] };
      return { names: this.objectNames('device') };
    }

    cmdStatus(args) {
      const names = args.length
        ? expandNodeSpec(args.join(','))
        : this.objectNames('device');
      const out = [];
      for (const n of names) {
        const d = this.effective('device', n);
        if (!d) { out.push(err('No device named "' + n + '"')); continue; }
        out.push(line(dotted(n, 26) + ' [ ' + d.status + ' ]'));
      }
      return out;
    }

    cmdPower(args) {
      const op = args.find(a => POWER_OPS.includes(a)) || 'status';
      const rest = args.filter(a => a !== op);
      const t = this.powerTargets(rest);
      if (t.error) return t.error;
      const out = [];

      for (const n of t.names) {
        const d = this.state.devices[n];
        const eff = this.effective('device', n);
        if (!eff) { out.push(err('No device named "' + n + '"')); continue; }
        if (!d) { out.push(err('power: "' + n + '" is not committed yet')); continue; }

        const fmt = st => dotted('ipmi0', 26) + ' [ ' + st + ' ] ' + n;

        if (op === 'status') {
          out.push(line(fmt(d.power.toUpperCase())));
        } else if (op === 'off') {
          d.power = 'off';
          d.status = 'DOWN';
          out.push(line(fmt('OFF')));
          this.schedule(() => this.emitEvent(n + ' [ DOWN ]', 'warning'), 800);
        } else if (op === 'on' || op === 'reset') {
          d.power = 'on';
          out.push(line(fmt(op === 'reset' ? 'RESET' : 'ON')));

          if (d.mac === ZERO_MAC) {
            // The BMC powers the node, but the provisioning system cannot
            // identify a node whose MAC it has never seen.
            d.status = 'DOWN';
            this.schedule(() => this.emitEvent(
              'PXE boot request from unknown MAC address; ' + n +
              ' cannot be identified (set its mac and commit)', 'warning'), 1800);
          } else if (!d.provisioned) {
            // First boot of a known node: full provisioning from its image.
            d.status = 'INSTALLER_BOOTING';
            const image = this.nodeImage(n);
            this.schedule(() => {
              d.status = 'INSTALLING';
              this.emitEvent('Provisioning started: sending ' + this.state.cluster +
                ':/cm/images/' + image + ' to ' + n + ':/, mode FULL, dry run = no');
            }, 2000);
            this.schedule(() => {
              d.provisioned = true;
              d.runningimage = image;
              d.status = 'UP';
              this.emitEvent('Provisioning completed: sent ' + this.state.cluster +
                ':/cm/images/' + image + ' to ' + n + ':/');
              this.emitEvent(n + ' [ UP ]');
            }, 6000);
          } else {
            d.status = 'INSTALLER_BOOTING';
            this.schedule(() => { d.status = 'INSTALLING'; this.onStateChange(); }, 2000);
            this.schedule(() => {
              d.status = 'UP';
              this.emitEvent(n + ' [ UP ]');
            }, 4500);
          }
        }
      }
      return out;
    }

    /* Software image a node provisions from, via its category. */
    nodeImage(name) {
      const d = this.effective('device', name);
      const cat = d && d.category && this.effective('category', d.category);
      return (cat && cat.softwareimage) || 'default-image';
    }

    cmdImageUpdate(args) {
      const write = args.includes('-w');
      if (!args.includes('-n') && !this.session.object) {
        return [err('imageupdate: no nodes selected (use -n, e.g. imageupdate -n node001..node004)')];
      }
      const t = this.powerTargets(args.filter(a => a !== '-w'));
      if (t.error) return t.error;
      const names = t.names.filter(n =>
        (this.effective('device', n) || {}).type === 'PhysicalNode');
      if (!names.length) return [err('imageupdate: no physical nodes selected')];

      const out = [];
      if (!write) {
        out.push(line('Performing dry run (pass -w to actually write changes)', 'muted'));
      }
      for (const n of names) {
        const d = this.state.devices[n];
        if (!d) { out.push(err('imageupdate: "' + n + '" is not committed yet')); continue; }
        if (d.status !== 'UP') { out.push(err(n + ': not UP, cannot update image')); continue; }
        const image = this.nodeImage(n);
        out.push(line(dotted(n, 26) + ' [ image update started ]'));
        this.schedule(() => {
          this.emitEvent('Provisioning started: sending ' + this.state.cluster +
            ':/cm/images/' + image + ' to ' + n + ':/, mode UPDATE, dry run = ' + (write ? 'no' : 'yes'));
        }, 700);
        this.schedule(() => {
          if (write) d.runningimage = image;
          this.emitEvent('Provisioning completed: sent ' + this.state.cluster +
            ':/cm/images/' + image + ' to ' + n + ':/' + (write ? '' : ' (dry run, no changes written)'));
        }, 3200);
      }
      return out;
    }

    cmdSysinfo(args) {
      const t = this.resolveTarget(args);
      if (t.error) return t.error;
      const d = this.effective('device', t.name);
      const gpu = d.category && d.category.includes('gpu');
      return table(['Parameter', 'Value'], [
        ['Hostname', t.name],
        ['System', d.type === 'HeadNode' ? 'Dell PowerEdge R760' : 'NVIDIA DGX H100'],
        ['CPU', '2x Intel(R) Xeon(R) Platinum 8480+ (56 cores)'],
        ['Memory', d.type === 'HeadNode' ? '512 GiB' : '2048 GiB'],
        ['GPU', gpu || d.type === 'PhysicalNode' ? '8x NVIDIA H100 80GB HBM3' : ''],
        ['OS', 'Rocky Linux 9.4'],
        ['BCM version', '11.0'],
        ['Kernel', '5.14.0-427.13.1.el9_4.x86_64'],
      ]);
    }

    cmdMetrics(args) {
      const t = this.resolveTarget(args);
      if (t.error) return t.error;
      const d = this.effective('device', t.name);
      if (d.status !== 'UP') return [err(t.name + ' is not up; no recent metric data')];
      const r = (lo, hi, dp) => (lo + Math.random() * (hi - lo)).toFixed(dp);
      const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
      return table(['Metric', 'Measurable', 'Value', 'Time'], [
        ['CPUUser', 'cpu', r(2, 45, 1) + '%', now],
        ['LoadOne', 'load', r(0.1, 8, 2), now],
        ['MemoryUsed', 'memory', r(40, 900, 0) + ' GiB', now],
        ['gpu_utilization', 'gpu:average', r(0, 98, 1) + '%', now],
        ['gpu_temperature', 'gpu:average', r(35, 78, 0) + ' C', now],
      ]);
    }

    cmdEvents(args) {
      let n = 10;
      const numArg = args.find(a => /^\d+$/.test(a));
      if (numArg) n = parseInt(numArg, 10);
      const log = this.eventLog.slice(-n);
      if (!log.length) return [line('No events recorded yet.', 'muted')];
      return log.map(e => line(e.stamp + ' [' + e.severity + '] ' +
        this.state.cluster + ': ' + e.text, 'event'));
    }

    /* ---------- tab completion ---------- */

    complete(text) {
      const endsWithSpace = /\s$/.test(text);
      const tokens = text.trim().length ? text.trim().split(/\s+/) : [];
      const current = endsWithSpace ? '' : (tokens.pop() || '');
      const prev = tokens;
      const mode = this.session.mode;

      let candidates = [];
      if (prev.length === 0) {
        candidates = [...Object.keys(MODES), 'main'].concat(GLOBAL_COMMANDS);
        if (mode === 'device') candidates = candidates.concat(DEVICE_COMMANDS);
      } else {
        const cmd = prev[0];
        const objects = mode ? this.objectNames(mode) : [];
        const props = mode ? MODES[mode].props : [];
        if (['use', 'show', 'remove', 'clone', 'sysinfo', 'latestmetricdata', 'status'].includes(cmd)) {
          candidates = objects;
        } else if (['get', 'set', 'clear'].includes(cmd)) {
          // Second token can be an object or a property; later tokens are properties.
          candidates = prev.length === 1 ? objects.concat(props) : props;
        } else if (cmd === 'power' || cmd === 'reboot') {
          candidates = prev[prev.length - 1] === '-n' ? objects : POWER_OPS.concat('-n');
        } else if (cmd === 'imageupdate') {
          candidates = prev[prev.length - 1] === '-n' ? objects : ['-n', '-w'];
        } else if (cmd === 'add' && mode === 'device') {
          candidates = ['physicalnode'];
        }
      }
      const matches = [...new Set(candidates)].filter(c => c.startsWith(current)).sort();
      return { matches, current };
    }
  }

  const api = { CmshEngine, expandNodeSpec, MODES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Cmsh = api;
})(typeof window !== 'undefined' ? window : globalThis);
