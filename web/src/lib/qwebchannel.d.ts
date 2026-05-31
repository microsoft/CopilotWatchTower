/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal typings for the QWebChannel transport injected by Qt.
// We declare them as `any` so dev-mode (running in a normal browser
// without Qt) still type-checks.

interface QtTransport {
  send(message: string): void;
  onmessage: ((message: { data: string }) => void) | null;
}

interface QtNamespace {
  webChannelTransport: QtTransport;
}

interface QWebChannelStatic {
  new (transport: QtTransport, callback: (channel: { objects: Record<string, any> }) => void): unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var qt: QtNamespace | undefined;
  // eslint-disable-next-line no-var
  var QWebChannel: QWebChannelStatic | undefined;
}

export {};
