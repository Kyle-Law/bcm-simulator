/* Initial cluster state for the cmsh simulator.
 * Models a small BCM 11 cluster: 1 head node, 8 compute nodes, 1 switch. */

(function (global) {
  'use strict';

  function makeInitialState() {
    const devices = {};

    devices['basecm11'] = {
      type: 'HeadNode',
      hostname: 'basecm11',
      category: '',
      mac: 'FA:16:3E:59:C9:35',
      ip: '10.141.255.254',
      network: 'internalnet',
      powercontrol: 'ipmi0',
      revision: '',
      status: 'UP',
      power: 'on',
      provisioned: true,
    };

    const macs = [
      'FA:16:3E:2E:D3:D6', 'FA:16:3E:A8:71:02', 'FA:16:3E:0C:9B:44',
      'FA:16:3E:61:E5:1A', 'FA:16:3E:97:3F:B8', 'FA:16:3E:4D:22:C7',
      'FA:16:3E:B0:88:53', 'FA:16:3E:19:6A:EF',
    ];
    for (let i = 1; i <= 8; i++) {
      const name = 'node' + String(i).padStart(3, '0');
      devices[name] = {
        type: 'PhysicalNode',
        hostname: name,
        category: 'default',
        mac: macs[i - 1],
        ip: '10.141.0.' + i,
        network: 'internalnet',
        powercontrol: 'ipmi0',
        revision: '',
        status: 'UP',
        power: 'on',
        provisioned: true,
      };
    }

    devices['switch01'] = {
      type: 'EthernetSwitch',
      hostname: 'switch01',
      category: '',
      mac: '44:38:39:00:AB:12',
      ip: '10.141.253.1',
      network: 'internalnet',
      powercontrol: 'custom',
      revision: '',
      status: 'UP',
      power: 'on',
      provisioned: true,
    };

    return {
      cluster: 'basecm11',
      devices,
      categories: {
        'default': {
          name: 'default',
          softwareimage: 'default-image',
          defaultgateway: '10.141.255.254',
          installmode: 'AUTO',
          newnodeinstallmode: 'FULL',
          revision: '',
        },
      },
      softwareimages: {
        'default-image': {
          name: 'default-image',
          path: '/cm/images/default-image',
          kernelversion: '5.14.0-427.13.1.el9_4.x86_64',
          revision: '',
        },
      },
      networks: {
        'internalnet': {
          name: 'internalnet',
          type: 'Internal',
          baseaddress: '10.141.0.0',
          netmaskbits: '16',
          domainname: 'cm.cluster',
          mtu: '1500',
          revision: '',
        },
        'externalnet': {
          name: 'externalnet',
          type: 'External',
          baseaddress: '192.168.32.0',
          netmaskbits: '24',
          domainname: 'example.com',
          mtu: '1500',
          revision: '',
        },
        'ipminet': {
          name: 'ipminet',
          type: 'Internal',
          baseaddress: '10.148.0.0',
          netmaskbits: '16',
          domainname: 'ipmi.cluster',
          mtu: '1500',
          revision: '',
        },
      },
      partitions: {
        'base': {
          name: 'base',
          clustername: 'Demo Training Cluster',
          administratoremail: '',
          timeservers: '0.pool.ntp.org',
          nameservers: '10.141.255.254',
          timezone: 'America/Los_Angeles',
          defaultcategory: 'default',
          revision: '',
        },
      },
      users: {},
      nextuid: 1001,
    };
  }

  const api = { makeInitialState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.CmshState = api;
})(typeof window !== 'undefined' ? window : globalThis);
