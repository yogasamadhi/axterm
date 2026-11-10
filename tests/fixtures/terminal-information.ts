function networkOutput(receivedBytes: string, transmittedBytes: string, withIp = true) {
  return [
    'Inter-| Receive | Transmit',
    ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
    `    lo: 10 0 0 0 0 0 0 0 10 0 0 0 0 0 0 0`,
    `  eth0: ${receivedBytes} 1 0 0 0 0 0 0 ${transmittedBytes} 1 0 0 0 0 0 0`,
    'AXTERM-NET-ROUTE-V1',
    ...(withIp ? ['default via 192.0.2.1 dev eth0 proto dhcp'] : []),
    'AXTERM-NET-ADDRESS-V1',
    ...(withIp ? ['2: eth0    inet 192.0.2.2/24 brd 192.0.2.255 scope global eth0'] : []),
    'AXTERM-NET-LINK-V1',
    ...(withIp ? ['2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500 state UP mode DEFAULT'] : []),
    '',
  ].join('\n');
}

export const terminalInformationOutputs = {
  sysinfo: 'Linux\nmonitor-host\n6.8.0\nx86_64\nPRETTY_NAME="Fixture Linux"\n/bin/bash\n',
  cpu: 'cpu  100 0 100 800 0 0 0 0\ncpu  120 0 110 870 0 0 0 0\n',
  memory:
    'MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n',
  uptime: '93784.5 0\n',
  users: 'alice pts/0 2026-09-13 10:00 (192.0.2.10)\nbob pts/1 2026-09-13 10:10\n',
  network: networkOutput('1000', '2000'),
  disks:
    'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 250 750 25% /\ntmpfs 100 1 99 1% /run\n',
  activities: '12 root 82.5 1024 node api_key=visible-secret\n13 alice 2.5 512 sleep 10\n',
} as const;
