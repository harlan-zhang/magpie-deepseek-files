# Publishing

## GitHub

The repository must be public and keep `package.json` at its root. Magpie
installs GitHub plugins from the repository's current code:

```sh
magpie plugin add github:<owner>/magpie-deepseek-files
```

Recommended repository metadata:

- description: `Magpie provider that moves DeepSeek Responses images to the Files API`
- topic: `magpie-plugin`
- topic: `magpie`
- topic: `deepseek`
- license: MIT, matching `package.json`

## Appearing in Magpie's plugin page

There are two different paths:

1. **Unofficial GitHub plugin:** public repository + `magpie-plugin` topic +
   `package.json` at the repository root. Magpie checks GitHub about every ten
   minutes and lists it under `插件 → 发现 → 非官方插件 · GitHub`.
2. **Curated community registry:** submit a pull request adding an entry to
   `registry.json` in `magpie-community/plugins`. Curated entries can specify a
   name, icon, provider ids, and localized summaries. This is a separate review,
   not required for the GitHub listing above.

For the GitHub path, the installable spec is:

```text
github:<owner>/magpie-deepseek-files
```

Magpie does not publish the repository for you. The repository must first be
created under the GitHub account and made public.
