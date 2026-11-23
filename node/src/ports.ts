/** What to say when the port a node or a router listens on is taken: usually the same thing already running from an
 * earlier start, sometimes another program. Said instead of the stack trace Node prints for EADDRINUSE. */
export function portTaken(who: 'node' | 'router', port: number, host: string): string {
  return who === 'node'
    ? `port ${port} on ${host} is already in use, most likely by this node from an earlier start (orrery provider status --config … says if it is running). Stop that one, or set "listen" in provider.json to a free port; if "publicUrl" names the port, change it too and run orrery provider register again`
    : `port ${port} on ${host} is already in use, most likely by a router from an earlier start (orrery doctor says if one is running). Stop that one, or start this one with --port <another port> and point your tools at it`;
}

/** listen() on a server, rejecting with portTaken's words when the port is in use and with the error otherwise. */
export function listenOn(server: import('node:http').Server, port: number, host: string, who: 'node' | 'router'): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new Error(portTaken(who, port, host)) : e);
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      resolve();
    });
  });
}
