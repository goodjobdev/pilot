# Pilot documentation site

Canonical Markdown lives in the parent repository's `docs/` tree. Read `../docs/DOCUMENTATION.md` before adding pages. Only `pages.json` entries publish; generated output is disposable.

This is an isolated pnpm package with its own lockfile. It neither changes Pilot's production dependencies nor replaces the Svelte UI.

```sh
pnpm --dir docs-site install --frozen-lockfile
pnpm --dir docs-site check
pnpm --dir docs-site build
pnpm --dir docs-site dev
```

Dependencies are pinned exactly and committed with `pnpm-lock.yaml`: `astro` 7.4.5, `@astrojs/starlight` 0.42.8, `@astrojs/markdown-remark` 7.3.5, `yaml` 2.9.1, and the `@astrojs/check`/`typescript` development tools. `pnpm-workspace.yaml` records pnpm's automatic `minimumReleaseAgeExclude` entry for the freshly published `astro@7.4.5`, which is the one freshness-gate bypass in this tree: remove it and re-resolve to a version older than the gate window if that is preferred.

The last command binds loopback. No public docs deployment is configured or implied. The runtime application build does not build or bundle the site. Site assets need an explicitly reviewed publishing path; private project images are not copied automatically.
