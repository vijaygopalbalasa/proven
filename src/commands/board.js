import { startBoard } from '../board/server.js';
import { Refusal } from '../errors.js';

// proven board [--port 8090] [--judge]: serve the board until Ctrl+C. Judge mode (npm start) adds a note that the
// cards come from committed receipts and that new Kane runs need kane-cli login.
export async function cmdBoard({ root, out }, _args, flags) {
  const port = flags.port === undefined ? 8090 : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Refusal('--port needs a port number, like --port 8090.');
  const judge = Boolean(flags.judge);
  const board = await startBoard(root, { port, judge });
  out.say(`Board: http://localhost:${board.port}/  (Ctrl+C to stop)`);
  if (judge) {
    out.say('Judge mode: the cards come from the receipts and state committed in this repository, and each done card\'s receipt is re-checked with git.');
    out.say('New Kane runs (proven red, proven done, proven verify --replay) need Kane CLI (npm install -g @testmuai/kane-cli) and kane-cli login.');
  }
  await new Promise((done) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      done();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await board.close();
  return 0;
}
