/* Guided lessons for the cmsh simulator.
 * Each step has a check(ctx) run after every command; ctx = { engine, cmd, output }.
 * cmd is the trimmed command string just executed; output is its text. */

(function (global) {
  'use strict';

  function ranCmd(ctx, re) { return re.test(ctx.cmd); }

  const LESSONS = [
    {
      id: 'navigation',
      title: 'Finding your way around',
      blurb: 'cmsh is organized into modes, one per type of cluster object. Learn to move between them.',
      steps: [
        {
          text: 'See what cmsh offers: run "help" at the top level.',
          hint: 'help',
          check: ctx => ranCmd(ctx, /^help\b/) && !ctx.engine.session.mode,
        },
        {
          text: 'Enter device mode by typing "device". Watch the prompt change to [basecm11->device]%.',
          hint: 'device',
          check: ctx => ctx.engine.session.mode === 'device',
        },
        {
          text: 'List all devices in the cluster with "ls" (or "list").',
          hint: 'ls',
          check: ctx => ctx.engine.session.mode === 'device' && ranCmd(ctx, /^(ls|list)\b/),
        },
        {
          text: 'Inspect one node: "show node001" prints every property of the object.',
          hint: 'show node001',
          check: ctx => ranCmd(ctx, /^show\s+node001\b/),
        },
        {
          text: 'Return to the top level with "home". ("exit" or ".." goes up one level at a time.)',
          hint: 'home',
          check: ctx => !ctx.engine.session.mode && ranCmd(ctx, /^(home|exit|\.\.)\s*$/),
        },
      ],
    },
    {
      id: 'power',
      title: 'Device status & power',
      blurb: 'Check node health and control power through the BMC — the bread and butter of node operations.',
      steps: [
        {
          text: 'In device mode, run "status" to see the state of every device.',
          hint: 'device; status',
          check: ctx => ctx.engine.session.mode === 'device' && ranCmd(ctx, /^status\b/),
        },
        {
          text: 'Check power state for all nodes: "power status".',
          hint: 'power status',
          check: ctx => ranCmd(ctx, /^power(\s+status)?\s*$/),
        },
        {
          text: 'Power off node002: "power off -n node002". Watch the rack view and the event line.',
          hint: 'power off -n node002',
          check: ctx => ctx.engine.state.devices.node002 && ctx.engine.state.devices.node002.power === 'off',
        },
        {
          text: 'Power it back on: "power on -n node002". The node boots through INSTALLER_BOOTING before reaching UP.',
          hint: 'power on -n node002',
          check: ctx => ctx.engine.state.devices.node002 && ctx.engine.state.devices.node002.power === 'on',
        },
        {
          text: 'Power operations accept ranges. Reset three nodes at once: "power reset -n node003..node005".',
          hint: 'power reset -n node003..node005',
          check: ctx => ranCmd(ctx, /^(power\s+reset|reboot)\s+-n\s+\S*\.\.\S*/) || ranCmd(ctx, /-n\s+node003\.\.node005/) && ranCmd(ctx, /reset|reboot/),
        },
      ],
    },
    {
      id: 'commit',
      title: 'Editing properties: set, commit, refresh',
      blurb: 'Changes in cmsh are staged locally until you commit. The * in the prompt marks uncommitted work.',
      steps: [
        {
          text: 'Enter partition mode and select the cluster-wide settings object: "partition; use base".',
          hint: 'partition; use base',
          check: ctx => ctx.engine.session.mode === 'partition' && ctx.engine.session.object === 'base',
        },
        {
          text: 'Read the current time servers: "get timeservers".',
          hint: 'get timeservers',
          check: ctx => ranCmd(ctx, /^get\s+(base\s+)?timeservers\b/),
        },
        {
          text: 'Change them: "set timeservers pool.ntp.org". Notice the * that appears in the prompt — the change is only staged.',
          hint: 'set timeservers pool.ntp.org',
          check: ctx => {
            const s = ctx.engine.getStaged('partition', 'base');
            return !!(s && s.props.timeservers);
          },
        },
        {
          text: 'Run "modified" to list objects with uncommitted changes.',
          hint: 'modified',
          check: ctx => ranCmd(ctx, /^modified\b/),
        },
        {
          text: 'Save the change with "commit". The * disappears.',
          hint: 'commit',
          check: ctx => ctx.engine.state.partitions.base.timeservers !== '0.pool.ntp.org' &&
            !ctx.engine.isModified('partition', 'base'),
        },
        {
          text: 'Now practice backing out: "set timezone Europe/Amsterdam", then discard it with "refresh".',
          hint: 'set timezone Europe/Amsterdam; refresh',
          check: ctx => ranCmd(ctx, /^refresh\b/) &&
            !ctx.engine.isModified('partition', 'base') &&
            ctx.engine.state.partitions.base.timezone !== 'Europe/Amsterdam',
        },
      ],
    },
    {
      id: 'categories',
      title: 'Node categories',
      blurb: 'Categories let you configure groups of nodes identically. Clone one, then reassign a node to it.',
      steps: [
        {
          text: 'Enter category mode and list the existing categories.',
          hint: 'category; ls',
          check: ctx => ctx.engine.session.mode === 'category' && ranCmd(ctx, /^(ls|list)\b/),
        },
        {
          text: 'Clone the default category: "clone default gpu". cmsh switches you to the new (uncommitted) object.',
          hint: 'clone default gpu',
          check: ctx => ctx.engine.objectNames('category').includes('gpu'),
        },
        {
          text: 'Commit the new category.',
          hint: 'commit',
          check: ctx => !!ctx.engine.state.categories.gpu,
        },
        {
          text: 'Move node007 into it. From device mode: "set node007 category gpu" — you can name the object right in the command.',
          hint: 'device; set node007 category gpu',
          check: ctx => (ctx.engine.effective('device', 'node007') || {}).category === 'gpu',
        },
        {
          text: 'Commit, then "ls" to confirm node007 now shows category gpu.',
          hint: 'commit; ls',
          check: ctx => ctx.engine.state.devices.node007 &&
            ctx.engine.state.devices.node007.category === 'gpu' &&
            !ctx.engine.isModified('device', 'node007'),
        },
      ],
    },
    {
      id: 'images',
      title: 'Software images',
      blurb: 'Nodes are provisioned from software images. Clone one to customize it without touching production.',
      // Pre-create a gpu category so this lesson stands alone.
      setup(state) {
        state.categories.gpu = Object.assign({}, state.categories.default, { name: 'gpu' });
      },
      steps: [
        {
          text: 'Enter softwareimage mode and list the images.',
          hint: 'softwareimage; ls',
          check: ctx => ctx.engine.session.mode === 'softwareimage' && ranCmd(ctx, /^(ls|list)\b/),
        },
        {
          text: 'Clone it: "clone default-image gpu-image".',
          hint: 'clone default-image gpu-image',
          check: ctx => ctx.engine.objectNames('softwareimage').includes('gpu-image'),
        },
        {
          text: 'Commit. BCM starts generating the initial ramdisk in the background — watch for the event.',
          hint: 'commit',
          check: ctx => !!ctx.engine.state.softwareimages['gpu-image'],
        },
        {
          text: 'Point the gpu category at the new image: in category mode, "set gpu softwareimage gpu-image", then commit. (A gpu category is already present in this lab.)',
          hint: 'category; set gpu softwareimage gpu-image; commit',
          check: ctx => ctx.engine.state.categories.gpu &&
            ctx.engine.state.categories.gpu.softwareimage === 'gpu-image',
        },
      ],
    },
    {
      id: 'provision',
      title: 'Provisioning a new node',
      blurb: 'A new server just arrived in the rack. Register it in BCM, identify it by MAC address, and provision it from a software image.',
      steps: [
        {
          text: 'In device mode, create the node object: "add physicalnode node009 10.141.0.9", then commit. It appears in the rack, powered off.',
          hint: 'device; add physicalnode node009 10.141.0.9; commit',
          check: ctx => !!ctx.engine.state.devices.node009,
        },
        {
          text: 'Power it on: "power on -n node009". Watch the event line — the node PXE boots, but BCM can\'t identify it because its MAC address is unknown.',
          hint: 'power on -n node009',
          check: ctx => ctx.engine.state.devices.node009 &&
            ctx.engine.state.devices.node009.power === 'on' &&
            ctx.engine.state.devices.node009.mac === '00:00:00:00:00:00',
        },
        {
          text: 'Read the MAC off the server\'s asset label and register it: "set node009 mac 04:7B:CB:00:99:01", then commit.',
          hint: 'set node009 mac 04:7B:CB:00:99:01; commit',
          check: ctx => ctx.engine.state.devices.node009 &&
            ctx.engine.state.devices.node009.mac !== '00:00:00:00:00:00' &&
            !ctx.engine.isModified('device', 'node009'),
        },
        {
          text: 'Boot it again: "power reset -n node009". Now the node-installer recognizes it and provisions default-image onto it — watch INSTALLER_BOOTING → INSTALLING → UP in the rack.',
          hint: 'power reset -n node009',
          check: ctx => {
            const d = ctx.engine.state.devices.node009;
            return !!(d && d.power === 'on' && d.mac !== '00:00:00:00:00:00' &&
              /^(power\s+(on|reset)|reboot)\b/.test(ctx.cmd));
          },
        },
        {
          text: 'Running nodes drift from their image over time. Try syncing one: "imageupdate -n node001". Note it only does a dry run.',
          hint: 'imageupdate -n node001',
          check: ctx => /^imageupdate\b/.test(ctx.cmd) && !/\s-w\b/.test(ctx.cmd),
        },
        {
          text: 'Do it for real with the -w flag: "imageupdate -w -n node001".',
          hint: 'imageupdate -w -n node001',
          check: ctx => /^imageupdate\b/.test(ctx.cmd) && /\s-w\b/.test(ctx.cmd),
        },
      ],
    },
    {
      id: 'users',
      title: 'Managing users',
      blurb: 'BCM manages cluster users through LDAP behind the scenes; in cmsh it\'s just user mode.',
      steps: [
        {
          text: 'Enter user mode and list users (empty so far).',
          hint: 'user; ls',
          check: ctx => ctx.engine.session.mode === 'user' && ranCmd(ctx, /^(ls|list)\b/),
        },
        {
          text: 'Create a user: "add jsmith". cmsh switches to the new object.',
          hint: 'add jsmith',
          check: ctx => ctx.engine.objectNames('user').includes('jsmith'),
        },
        {
          text: 'Set a password: "set password Ch4ngeMe!".',
          hint: 'set password Ch4ngeMe!',
          check: ctx => {
            const s = ctx.engine.getStaged('user', 'jsmith');
            const c = ctx.engine.state.users.jsmith;
            return !!((s && s.props.password) || (c && c.password));
          },
        },
        {
          text: 'Inspect the account with "show" — note the auto-assigned UID and home directory.',
          hint: 'show',
          check: ctx => ctx.engine.session.mode === 'user' && ranCmd(ctx, /^show\b/),
        },
        {
          text: 'Commit to create the account.',
          hint: 'commit',
          check: ctx => !!ctx.engine.state.users.jsmith,
        },
      ],
    },
    {
      id: 'monitoring',
      title: 'Bonus: monitoring & node info',
      blurb: 'Query live hardware info and metrics that BCM collects from every node.',
      steps: [
        {
          text: 'In device mode, run "sysinfo node001" to see the hardware BCM detected.',
          hint: 'device; sysinfo node001',
          check: ctx => ranCmd(ctx, /^sysinfo\b/),
        },
        {
          text: 'Pull the latest metrics: "latestmetricdata node001".',
          hint: 'latestmetricdata node001',
          check: ctx => ranCmd(ctx, /^latestmetricdata\b/),
        },
        {
          text: 'Try it on a powered-off node: "power off -n node008", then "latestmetricdata node008". No data from a dead node. Power it back on when done.',
          hint: 'power off -n node008; latestmetricdata node008',
          check: ctx => ranCmd(ctx, /^latestmetricdata\s+node008\b/) &&
            ctx.engine.state.devices.node008.status !== 'UP',
        },
      ],
    },
  ];

  const api = { LESSONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.CmshLessons = api;
})(typeof window !== 'undefined' ? window : globalThis);
