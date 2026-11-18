# Branch and release workflow

- main is the stable release and the source for the public GitHub Pages site.
- dev is the integration branch for testing unreleased stages, including two-arm control, cameras, and the mobile base.
- Start feature branches for new stages from dev. Integrate and test those changes on dev.
- Do not merge, cherry-pick, enable, or publish a development stage to main unless the user explicitly requests release of that stage. A request to implement or test a feature does not authorize its release on main.
- Keep GitHub Pages configured to publish main. Do not point the public site at dev.
- Stable fixes and guide updates should use a feature branch from main, be verified, and be merged with normal Git history. Carry applicable fixes back into dev.
- Keep release availability in STUDIO_RELEASE in pages-arm.js. The UI and USB/route checks must use the same availability.
- Commit reviewable changes. Do not force-push shared branches or rewrite published history.
