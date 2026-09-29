# Third-party notices

`dist/index.js` is a bundled, self-contained artifact — see `build.mjs`. So that
an out-of-tree DSH plugin can be loaded without a `node_modules` next to it, the
build **inlines** the helper packages below into the bundle. Their source is
therefore redistributed inside `dist/index.js` and their licenses apply to it.

| Package | Version inlined | License | Copyright |
|---|---|---|---|
| `@deepseek-ai/schemastery` | 3.18.4 | MIT | Copyright (c) 2021-present Shigma |
| `@deepseek-ai/dsh-tools` | 0.1.7-rc.2 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-llm` | 0.1.7-rc.2 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-output-retention` | 0.1.7-rc.2 | MIT | Copyright (c) 2026 DeepSeek |

Versions are the ones present in the `node_modules` tree used for the last
build. The build inlines whatever is installed there, so this table must be
re-checked when the DSH runtime is upgraded.

Everything under `lib/`, `test/` and the build/packaging scripts is original to
this project and is covered by the root `LICENSE` (MIT).

## MIT License

Applies to each package listed above. Copyright notices:

- Copyright (c) 2021-present Shigma
- Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Note on how this file is attached

`build.mjs` sets esbuild's `legalComments: 'none'`, which strips the inlined
packages' license comments from `dist/index.js`. This file is therefore the
channel through which the notices travel with the binary. A build-time banner
carrying the same notices would be strictly better — it puts them where MIT
requires them (in the copy that is distributed) instead of beside it. That
change regenerates `dist/index.js` and is deferred to a version that is not
already packaged as a release archive.
