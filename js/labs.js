/* Troubleshooting labs for the cmsh simulator.
 *
 * Each lab starts from its own broken cluster fixture (setup) and is graded on
 * committed cluster state, not on the commands typed. A lab is solved when every
 * goal's done(engine) returns true. This is the "isolate my learning to one
 * task" surface: pick a lab, get a purpose-built cluster, fix it.
 *
 * setup(state, engine) mutates the fresh state (and may stage session changes).
 * goals[].done(engine) reads engine.state (committed values).
 */

(function (global) {
  'use strict';

  const ZERO_MAC = '00:00:00:00:00:00';

  const LABS = [
    {
      id: 'node-down',
      title: 'Node offline after maintenance',
      difficulty: 'Beginner',
      briefing:
        'A field technician finished a memory swap on node005 and left it powered ' +
        'off. Jobs are queued waiting for it. Bring node005 back online.',
      setup(state) {
        const d = state.devices.node005;
        d.power = 'off';
        d.status = 'DOWN';
      },
      goals: [
        { text: 'node005 is UP', done: e => e.state.devices.node005.status === 'UP' },
      ],
      hints: [
        'Enter device mode and run "status" — which device is DOWN?',
        'The node is provisioned already; it just needs power. Try "power on -n node005".',
      ],
    },

    {
      id: 'fix-provisioning',
      title: "node003 won't provision",
      difficulty: 'Beginner',
      briefing:
        'A replacement server was racked as node003, but it never finishes booting. ' +
        'The node object exists, yet the provisioning system keeps rejecting it. ' +
        'Find out why and get node003 to UP.',
      setup(state) {
        const d = state.devices.node003;
        d.mac = ZERO_MAC;      // its real MAC was never recorded
        d.provisioned = false;
        d.runningimage = '';
        d.status = 'DOWN';
        d.power = 'off';
      },
      goals: [
        {
          text: 'node003 has a real MAC address (committed)',
          done: e => e.state.devices.node003.mac !== ZERO_MAC,
        },
        { text: 'node003 is UP', done: e => e.state.devices.node003.status === 'UP' },
      ],
      hints: [
        'Power it on first and read the event line: "power on -n node003", then "events".',
        'BCM can\'t identify a node whose MAC it has never seen. Its label reads 0C:42:A1:03:00:33.',
        'set the mac, commit, then "power reset -n node003" to provision it.',
      ],
    },

    {
      id: 'stuck-changes',
      title: 'The change that never took effect',
      difficulty: 'Intermediate',
      briefing:
        'A colleague started updating the cluster NTP server, got paged, and walked ' +
        'away mid-task. Their cmsh session left an uncommitted change behind. The ' +
        'correct time server is "time.cluster.local" — make sure it is applied and ' +
        'nothing is left pending.',
      setup(state, engine) {
        engine.session.mode = 'partition';
        engine.session.object = 'base';
        const s = engine.ensureStaged('partition', 'base');
        s.props.timeservers = '10.0.0.1'; // a half-finished, wrong edit
      },
      goals: [
        {
          text: 'Time servers committed as "time.cluster.local"',
          done: e => e.state.partitions.base.timeservers === 'time.cluster.local',
        },
        {
          text: 'No uncommitted changes remain',
          done: e => !Object.values(e.session.staged)
            .some(x => x.isNew || x.removed || Object.keys(x.props).length),
        },
      ],
      hints: [
        'Run "modified" to see what was left uncommitted, and where.',
        'In partition mode: "use base", then "get timeservers" shows the staged value.',
        'Fix it with "set timeservers time.cluster.local", then "commit".',
      ],
    },

    {
      id: 'broken-image-ref',
      title: 'Category points at a missing image',
      difficulty: 'Intermediate',
      briefing:
        'Someone deleted an old software image without repointing the categories that ' +
        'used it. The "default" category now references an image that no longer exists, ' +
        'so new nodes fail to provision. Repair the reference to a real image.',
      setup(state) {
        state.categories.default.softwareimage = 'legacy-image-removed';
      },
      goals: [
        {
          text: 'default category points at an image that exists',
          done: e => !!e.state.softwareimages[e.state.categories.default.softwareimage],
        },
      ],
      hints: [
        'In category mode, "show default" reveals the dangling software image name.',
        'List the images that actually exist: "softwareimage; ls".',
        'Back in category mode: "set default softwareimage default-image", then "commit".',
      ],
    },

    {
      id: 'wrong-image',
      title: 'GPU node running the wrong image',
      difficulty: 'Advanced',
      briefing:
        'node007 is meant to run GPU workloads from "gpu-image", but users report ' +
        'missing CUDA drivers. It is still running the default image. A gpu category ' +
        'and gpu-image already exist — move node007 onto them and make it actually run ' +
        'gpu-image.',
      setup(state) {
        state.softwareimages['gpu-image'] = {
          name: 'gpu-image',
          path: '/cm/images/gpu-image',
          kernelversion: state.softwareimages['default-image'].kernelversion,
          revision: '',
        };
        state.categories.gpu = Object.assign({}, state.categories.default, {
          name: 'gpu', softwareimage: 'gpu-image',
        });
        // node007 is still on default / default-image — that's the fault.
      },
      goals: [
        {
          text: 'node007 is in the gpu category (committed)',
          done: e => e.state.devices.node007.category === 'gpu',
        },
        {
          text: 'node007 is actually running gpu-image',
          done: e => e.state.devices.node007.runningimage === 'gpu-image',
        },
      ],
      hints: [
        'Check what it runs now: "device; get node007 runningimage".',
        'Reassign it: "set node007 category gpu", then "commit". Category alone does not resync the disk.',
        'Push the new image to it for real: "imageupdate -w -n node007" (a plain imageupdate is only a dry run).',
      ],
    },
  ];

  const api = { LABS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.CmshLabs = api;
})(typeof window !== 'undefined' ? window : globalThis);
