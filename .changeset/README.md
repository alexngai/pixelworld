# Changesets

`pixelworld` (packages/pixelworld) is versioned with [changesets](https://github.com/changesets/changesets). The workspace's private packages (`@pixelworld/*`, the apps, the examples) are not.

- **A change to what the package ships:** run `pnpm changeset`, pick `pixelworld` and a bump (patch or minor; major after 1.0), and write one line for its changelog. Commit the file it adds here.
- **A release:** see [docs/npm.md, Releases](../docs/npm.md#releases). Publishing is manual.
