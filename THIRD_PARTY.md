# Third-party notices

GITMIR Claude Control is licensed under GPL-3.0. It bundles the following
third-party components in `vendor/`, each distributed under its own license
(mere aggregation — they are used unmodified). Their licenses continue to apply
to those files.

| Component | Version | License | File(s) |
|-----------|---------|---------|---------|
| [elkjs](https://github.com/kieler/elkjs) (Eclipse Layout Kernel, JS build) | 0.11.1 | [EPL-2.0](https://www.eclipse.org/legal/epl-2.0/) | `vendor/elk.bundled.js` |
| [Onest](https://github.com/getflourish/Onest) font | — | [SIL Open Font License 1.1](https://openfontlicense.org/) | `vendor/fonts/*.woff2`, `vendor/fonts.css` |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) font | — | [SIL Open Font License 1.1](https://openfontlicense.org/) | `vendor/fonts/*.woff2`, `vendor/fonts.css` |

The GITMIR wordmark and mark (`vendor/gitmir-wordmark.svg`, `vendor/gitmir-mark.svg`)
are trademarks/brand assets of GITMIR and are **not** covered by the GPL-3.0 grant
for the rest of the project; they are included for use within this tool only.

Fonts are served locally (a subset downloaded from Google Fonts, which distributes
Onest and JetBrains Mono under the SIL OFL). If you prefer, remove `vendor/fonts/`
and the `<link rel="stylesheet" href="/vendor/fonts.css">` line in `server.js` — the
UI falls back to system fonts.
