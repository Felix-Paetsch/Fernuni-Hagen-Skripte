import { shortHelp } from "./help.ts";

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function fail(message: string): never {
  throw new UserError(message);
}

export function reportAndExit(error: unknown): never {
  if (error instanceof UserError) {
    const message = error.message.endsWith("\n") ? error.message : `${error.message}\n`;
    process.stderr.write(message);
  } else if (error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }
  process.stderr.write(`\n${shortHelp()}`);
  process.exit(1);
}
