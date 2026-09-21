// Backward-compatible entry point for the former semantic-router UI smoke.
// Production now uses the Jev facade. Delegate to the real main/preload/renderer
// harness so both commands run the same Jev/CRUD gates and isolated boundaries.
// Arguments are preserved, including mandatory --mock-only and optional --screenshots.
// Run: electron.cmd scripts/test-friendly-ui.mjs --mock-only [--screenshots]
console.log('test-friendly-ui: запуск test-agent-ui.mjs (Jev и Gemini), изолированные проверки; параметры передаются без изменений.');
await import('./test-agent-ui.mjs');
