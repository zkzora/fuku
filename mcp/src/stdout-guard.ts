/**
 * stdout carries the MCP protocol (JSON-RPC over stdio): one stray line breaks the client. Imported
 * first by the entry point, so console.log / info / debug from this package or any dependency go to
 * stderr instead. Logging is console.error / console.warn (stderr) or log() below.
 */
const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

export function log(message: string): void {
  process.stderr.write(`[fuku-mcp] ${message}\n`);
}
