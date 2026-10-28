import { pathToFileURL } from "node:url";

import { commandHelp } from "./help.ts";

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.stdout.write(commandHelp());
}
