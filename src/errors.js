// A Refusal is a plain-English "no" for the person or the agent. It carries the exit code to use.
export class Refusal extends Error {
  constructor(message, { exitCode = 2 } = {}) {
    super(message);
    this.name = 'Refusal';
    this.exitCode = exitCode;
  }
}
