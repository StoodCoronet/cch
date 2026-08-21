#!/usr/bin/env node
// Alias of bin/ccd.js (cch lineage naming).
require('../index.js').main().catch(e => { console.error(e.message || e); process.exit(1); });
