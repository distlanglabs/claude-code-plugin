#!/usr/bin/env node
import { main } from "../src/status.js";

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
