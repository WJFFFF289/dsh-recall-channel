/**
 * Bundle the plugin into a self-contained ESM file.
 *
 * Out-of-tree DSH plugins are loaded from a linked or copied directory, where
 * Node resolves a bare import from the *real* package path — the profile's
 * module-link layer does not participate. Every `@deepseek-ai/*` helper this
 * plugin uses (schemastery, dsh-tools' `defineTool`, dsh-llm's
 * `createUserMessage`, dsh-output-retention's `TextRetainer`) is therefore
 * inlined, so `dist/index.js` has no runtime imports at all and needs no
 * node_modules next to it.
 *
 * None of those helpers is a cordis Service; they are pure factories/classes,
 * so inlining cannot fork service identity.
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['lib/index.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  legalComments: 'none',
  banner: {
    js: '// dsh-recall-channel — bundled build. Runtime imports are inlined; this file needs no node_modules.',
  },
})

console.log('built dist/index.js')
