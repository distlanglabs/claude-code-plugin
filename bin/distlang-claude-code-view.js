#!/usr/bin/env node
import { main } from "../src/view.js";

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
