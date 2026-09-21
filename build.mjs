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
 *
 * Post-processing exists so the "no runtime imports, no file access" claim is
 * enforced rather than asserted: the inlined dsh-llm reads its own
 * package.json for a User-Agent constant, and esbuild stamps the build
 * machine's absolute paths into the output as comments. Both are removed, and
 * the build fails loudly if the artifact ever regains an import or a
 * `require()`.
 */
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'

const OUTFILE = 'dist/index.js'

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
const llmPkg = JSON.parse(await readFile(new URL('./node_modules/@deepseek-ai/dsh-llm/package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['lib/index.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: OUTFILE,
  legalComments: 'none',
  define: { __RC_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: `// dsh-recall-channel v${pkg.version} — bundled build. Runtime imports are inlined; this file needs no node_modules.`,
  },
})

let code = await readFile(OUTFILE, 'utf8')
const built = code

// 1. The inlined dsh-llm resolves its own version by reading package.json at
//    load time. Bake the same value in at build time instead: identical
//    behaviour, but the shipped file performs no file I/O.
const versionRead = /^(?:var|const|let) \{ version \} = createRequire\(import\.meta\.url\)\("\.\.\/package\.json"\);$/m
if (!versionRead.test(code)) throw new Error('build: the inlined dsh-llm version read is missing — the bundle changed shape')
code = code.replace(versionRead, `const version = ${JSON.stringify(llmPkg.version)};`)

// 2. esbuild stamps every module's build-machine path as a comment.
code = code
  .split('\n')
  .filter((line) => !/^\/\/ .*node_modules[\\/]/.test(line))
  .join('\n')

// 3. `createRequire` is unused once step 1 ran.
code = code.replace(/^import \{ createRequire \} from "node:module";\n/m, '')

if (code === built) throw new Error('build: post-processing changed nothing — the bundle changed shape')
if (/^\s*import\s/m.test(code)) throw new Error('build: dist still contains an import statement')
if (/^\s*export\s.*\bfrom\b/m.test(code)) throw new Error('build: dist still re-exports from another module')
if (/\brequire\(/.test(code)) throw new Error('build: dist still calls require()')
if (/createRequire/.test(code)) throw new Error('build: dist still references createRequire')

await writeFile(OUTFILE, code)
console.log(`built ${OUTFILE} — v${pkg.version}, ${Buffer.byteLength(code)} bytes, zero runtime imports`)
