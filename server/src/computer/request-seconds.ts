/**
 * A command on a Bot's computer: `POST /api/computers/<bot>/exec`.
 *
 * `Bun.serve` closes a request that has sent nothing for 10 s, its default `idleTimeout`. A command prints nothing to
 * the person's request until it ends, and the shell gives it 120 s by default and up to 600 s, so anything slower than
 * 10 s (a `sleep`, an install, an OCR run) lost its request half-way: the browser's fetch failed, the Bot was told its
 * computer "could not be reached", and the command went on to finish inside the container with nobody to hear it.
 */
const EXEC_ROUTE = /^\/api\/computers\/[^/]+\/exec$/;

/**
 * How long OpenBot's server keeps a request to a computer route open, in seconds (http-server.ts applies it), or
 * undefined for every route that answers within Bun's own 10 s.
 *
 * 0 turns the idle timeout off for the command route (Bun: "`0` means no timeout"). The request still ends: the gateway
 * gives up on the computer at its own backstop (`COMMAND_BACKSTOP_MS`, just past the shell's 600 s ceiling).
 */
export function computerRequestSeconds(pathname: string): number | undefined {
  return EXEC_ROUTE.test(pathname) ? 0 : undefined;
}
