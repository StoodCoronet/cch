#!/usr/bin/env node
// Global-install entry point. index.js only runs main() when executed
// directly (require.main === module), so the bin wrapper calls it explicitly.
require('../index.js').main().catch(e => { console.error(e.message || e); process.exit(1); });
