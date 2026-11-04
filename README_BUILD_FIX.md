# MetaHopper frontend build correction

The attached BUILD.txt shows that the backend deployed successfully. The
frontend then failed because src/catalog.ts was missing. That missing import
also caused the nextToken implicit-any error.

The failed commit fe517a5ad3857b4becd954978002e1ed2ad1fded also lacks App.tsx,
main.tsx, style.css and vite-env.d.ts. The earlier update archive assumed these
files were already present. This correction supplies the complete frontend
source, restoring the missing files from the earlier repository history and
retaining the graph, FASTA and large-download changes.

## Apply

From the directory containing the downloaded ZIP:

```bash
unzip -o MetaHopper_Frontend_Build_Fix.zip -d ~/bin/metahopper-live
cd ~/bin/metahopper-live
npm test
npm run build
git add src tests
git commit -m "Restore frontend modules and enable large asset downloads"
git push origin main
```

Use your existing Node 22 frontend environment and installed dependencies.
Amplify will run its existing install and backend configuration steps before
building the frontend. If working through the GitHub web interface, upload all
the ZIP's src/ and tests/ files into those same repository directories, then
commit to main. Adding catalog.ts alone is insufficient for the failed commit
because the application entry point and dashboard are missing as well.

The ZIP contains src/, tests/ and this note. It does not contain project.ts,
Amplify backend resources, package.json, package-lock.json, or the generated
amplify_outputs.json. Keep those deployment-specific files from the repository
and the Amplify build. Assembly, mapping, CheckM and Bakta do not need to run
again for this frontend correction.

## Validation

- All 19 Node viewer tests passed.
- The source-file regression check correctly rejects a missing catalog.ts or
  main.tsx. It checks the HTML entry point and relative frontend imports.
- TypeScript checking and Vite production bundling passed with the frontend
  dependency versions recorded in the repository lockfile.
- The build check used a temporary, empty amplify_outputs.json only to compile
  locally. It is excluded from the ZIP; Amplify generates the real configuration
  during deployment.

No live AWS deployment was performed here. After pushing, wait for the new
Amplify build to succeed, then reload the viewer.
