// Backward-compatible entry point for the former semantic-router UI smoke.
// Production now uses AgentCommands. Delegate to the real main/preload/renderer
// agent harness so both commands run the same 10 gates and safety boundaries.
// Arguments are preserved, including mandatory --mock-only and optional --screenshots.
// Run: electron.cmd scripts/test-friendly-ui.mjs --mock-only [--screenshots]
console.log('test-friendly-ui: запуск нового test-agent-ui.mjs (AgentCommands), 10 проверок; параметры передаются без изменений.');
await import('./test-agent-ui.mjs');
