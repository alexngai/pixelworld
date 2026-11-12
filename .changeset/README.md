# Changesets

The published packages are versioned with [changesets](https://github.com/changesets/changesets): `pixelworld` (packages/pixelworld) and the city packs `@pixelworlds/city-*` (packages/city-*, D-074, D-105). The workspace's private packages (the other `@pixelworlds/*`, the apps, the examples) are not.

- **A change to what a package ships:** run `pnpm changeset`, pick the packages and a bump (patch or minor; major after 1.0), and write one line for its changelog. Commit the file it adds here.
- **They version on their own.** Each city pack names `pixelworld` as a peer (`workspace:^`, which `pnpm pack` turns into `^<pixelworld's version>`). A `pixelworld` release that leaves that range, a minor one before 1.0, also bumps the packs (patch) so they are republished with the new range; a patch release of `pixelworld` doesn't.
- **A release:** merge the "Version packages" pull request the release workflow opens; see [docs/npm.md, Releases](../docs/npm.md#9-releases).
