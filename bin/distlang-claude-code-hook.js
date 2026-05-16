#!/usr/bin/env node
import { main } from "../src/hook-handler.js";

main().catch(() => {
  process.exit(0);
});
