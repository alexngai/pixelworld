# Changesets

Two packages are versioned with [changesets](https://github.com/changesets/changesets): `pixelworld` (packages/pixelworld) and San Francisco's city pack `@pixelworlds/city-sf` (packages/city-sf, D-074). The workspace's private packages (the other `@pixelworlds/*`, the apps, the examples) are not.

- **A change to what a package ships:** run `pnpm changeset`, pick the package (or both) and a bump (patch or minor; major after 1.0), and write one line for its changelog. Commit the file it adds here.
- **The two version on their own.** The city pack names `pixelworld` as a peer (`workspace:^`, which `pnpm pack` turns into `^<pixelworld's version>`). A `pixelworld` release that leaves that range, a minor one before 1.0, also bumps the pack (patch) so it is republished with the new range; a patch release of `pixelworld` doesn't.
- **A release:** see [docs/npm.md, Releases](../docs/npm.md#9-releases). Publishing is manual.
