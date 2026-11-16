# MetaHopper live report portal

A small Amplify Gen 2 app that gives invited clients a searchable, scrollable row of sample tabs. Each tab runs the original MetaHopper HTML report. The interface lists a private S3 prefix every 30 seconds while the page is visible, plus on focus. Reports update automatically without routine refresh controls. No manifest generation or site redeployment is needed when reports change.

This is a separate app based on the login approach in [your upload portal](https://github.com/Middle-Author-Bioinformatics/sample-amplify-storage-browser). It creates its own Cognito user pool and S3 bucket. It does not change the upload portal or share its existing user accounts.

## Deploy once

1. Create a **private GitHub repository** named, for example, `metahopper-reports`. Unzip this project and commit its source at the repository root, including `package-lock.json`. Do not commit report HTML, pipeline data, credentials, `node_modules`, `dist`, or `amplify_outputs.json`.
2. In AWS Amplify, choose **Create new app**, connect that repository, and select its production branch. Use the included `amplify.yml` and an Amplify service role with the standard permissions needed to deploy Gen 2 backends. The build selects Node.js 22 and npm 10.9.4 automatically. Deploy. This creates the login resources, private bucket, and hosted frontend. The initial deployment can take several minutes.
3. From the deployed branch's backend outputs, record `auth.user_pool_id`, `storage.bucket_name`, and the AWS region. You can download `amplify_outputs.json` from Amplify or run `npx ampx generate outputs --app-id YOUR_APP_ID --branch main` with authorized AWS credentials. Use the **actual generated bucket name**, not its friendly label `metahopperReports`.
4. Open that user pool in Cognito. Create your own user, then your client's user, using email addresses and temporary passwords. Add Phoridae clients to **`phoridae-viewers`** and Aphrophora clients to **`aphrophora-viewers`**. Add Sample reports clients to **`sample-reports`**. For your own account, use **`metahopper-admins`** to review all projects. Users set a new password on first sign-in. Self-registration is disabled in Cognito as well as hidden in the UI. Users without a supported group cannot read reports. Assign clients to every project group they should be able to view; sign out and back in after membership changes. Cognito can send invitation emails when you create users; choose that deliberately in the console.
5. Publish a report using the instructions below. Open the Amplify HTTPS URL, sign in, and verify the report and controls. Share that URL with the invited client once the access checks below pass.

The sign-in page is reachable on the web; report contents and sample listings require authorized login. S3 public access is blocked and unauthenticated identity access is disabled. No S3 website endpoint is needed. Client credentials are temporary, read-only credentials scoped to the project prefix. Do not add public bucket policies or a `guest`/`authenticated` read rule.

## Publish from TheBelly

Project access is defined in `project.ts`, shared by Cognito, S3 permissions, and the dashboard:

| Client project | Reader group | S3 report prefix |
| --- | --- | --- |
| Phoridae | `phoridae-viewers` | `reports/phoridae/` |
| Aphrophora | `aphrophora-viewers` | `reports/aphrophora/` |
| Sample reports | `sample-reports` | `reports/sample-reports/` |

An account with one project opens it automatically. An account assigned to multiple project groups gets a selector containing only those projects. The optional **`metahopper-admins`** group has read-only access to all configured projects and gets a project selector. Only assign that group to trusted staff. Despite its name it cannot upload, delete, or manage users.

For each project, the app requests temporary credentials for that project’s Cognito group role using `GetCredentialsForIdentity.CustomRoleArn`. Cognito requires the requested role to be present in the user’s signed token; the S3 policies remain scoped to the selected project. Group permissions are not combined into a broad shared role. Staff use their existing all-project read role. Credential caches are separated by identity, ID token, and role, and cleared on sign-out. Backend IAM remains the security boundary, even if someone modifies browser code.

Changing projects clears the previous project's report frames and cancels pending requests. If any report has manual bin assignments, switching asks for confirmation so you can cancel and export first. Polling remains every 30 seconds while visible.

Each completed report has this S3 key:

```text
reports/phoridae/SPH1014/metahopper_report.html
reports/phoridae/SPH1870/metahopper_report.html
```

Use your existing AWS CLI credentials on TheBelly. A named `--profile` is optional; it is unrelated to dashboard client accounts. The supplied `scripts/belly-iam-policy.json` is an IAM identity-policy template for its publishing principal. Replace every bucket placeholder. It permits listing the three report prefixes and writing reports, with no read or delete permission. This publishing policy is for TheBelly, never client accounts; narrow it if a publisher should handle only one project. Use your normal AWS credential setup; never place AWS access keys in GitHub or frontend variables.

AWS CLI v1 and v2 are supported. The publisher disables the v2 API-output pager
using `AWS_PAGER=""` in the upload subprocess, without passing the v2-only
`--no-cli-pager` argument. Existing credentials, profiles and other environment
settings are preserved; installing another AWS CLI or changing Conda environments
is not required for this compatibility fix.

Compatibility validation: 33 publisher tests passed, including a strict v1-style
subprocess parser and rejection of empty staging paths. The publisher-built
PutObject command was also accepted by AWS CLI 1.46.3 against a stubbed S3 client;
the previous `--no-cli-pager` command was rejected. No live S3 requests were made.

Update your checkout on TheBelly with `git pull --ff-only`. The helper **requires `--prefix`**: it never guesses a destination from local folder names. It finds immediate sample folders and refreshes their reports from saved pipeline outputs. For each sample it stages the HTML and referenced FASTA, graph, annotation and pathway assets, uploads the assets before the report and taxonomy index, then removes that sample's temporary directory before preparing the next. It does not publish raw FASTQ reads or delete remote reports.

```bash
python3 scripts/publish_reports.py \
  --source "$HOME/Jagiellonian/Phoridae" \
  --pipeline-dir "$HOME/bin/MetaHopper" \
  --bucket YOUR_GENERATED_BUCKET_NAME \
  --prefix reports/phoridae/ \
  --staging-dir "$HOME/Jagiellonian/Phoridae/.publish-staging" \
  --dry-run
```

For Aphrophora, use the same bucket with a different explicit prefix:

```bash
PYTHONNOUSERSITE=1 python3 "$HOME/bin/metahopper-live/scripts/publish_reports.py" --source "$HOME/Jagiellonian/Aphrophora" --pipeline-dir "$HOME/bin/MetaHopper" --bucket YOUR_GENERATED_BUCKET_NAME --prefix reports/aphrophora/ --dry-run
```

`PYTHONNOUSERSITE=1` is a workaround for conflicting user-installed Python packages; it does not change AWS credentials. Omit it on systems that do not need it. Remove `--dry-run` to publish. Run after each pipeline batch completes. Hash-named immutable assets use size-only sync, so identical large files are not retransferred because of fresh local staging timestamps. The HTML and mutable manifest are uploaded separately; report changes produce a matching taxonomy index.

For one completed sample, select it with `--sample`:

```bash
python3 scripts/publish_reports.py \
  --source "$HOME/Jagiellonian/Phoridae" --sample SPH1014 \
  --pipeline-dir "$HOME/bin/MetaHopper" \
  --bucket YOUR_GENERATED_BUCKET_NAME --prefix reports/phoridae/
```

Publish completed sample outputs. The publisher respects the pipeline lock, validates sample ownership and hashes, and rejects assets that change during staging. New HTML is uploaded only after that sample's assets succeed. If a later sample fails, earlier completed publications remain available; retrying is safe and does not delete S3 objects.

### Temporary storage and missing graphs

Staging requires space for one sample's report assets, rather than the entire
project. `--staging-dir PATH` selects the temporary parent and creates it if
needed. The default honors `TMPDIR` or the system temporary directory. Select
a filesystem with sufficient free bytes **and inodes**; `df -h PATH` and
`df -i PATH` check both. On a disk/quota failure the partial sample's temporary
directory is removed and the error identifies the staging location and number
of samples completed earlier in that attempt. Original sample outputs remain.
The reusable staging parent can remain; each generated child directory is
removed after its sample.

An explicitly empty `--staging-dir ""` is rejected before staging or uploading.
If using a shell variable for this argument, set it in the current shell first.
Using an explicit directory path also avoids this issue across shell sessions.

`staged ... target s3://...` is a local preparation summary. `Published N/M`
confirms that the sample's assets, report and any available taxonomy index
finished uploading. A dry run is explicitly labeled and uploads nothing.

`graphs: 0` is separate from storage capacity: no usable source assembly graph
was imported. The publisher now warns and reports unmapped-contig reasons from
`assembly_graphs.final.json`; FASTA/annotation publishing can still proceed.
Inspect retained GFA/FASTG files and original MEGAHIT contigs before attempting
graph recovery. The publisher cannot restore missing original graph information
from renamed final FASTAs alone.

Staging-fix validation: 31 publisher tests passed, including per-sample cleanup,
asset-before-HTML ordering, a later sample running out of space, failed-upload
isolation, partial-copy cleanup, dry runs, profiles, and missing-graph warnings.

For periodic publication, use cron or a systemd timer on TheBelly to run the same helper after completed reports are available. Prevent overlapping runs, for example with `flock`. A one-minute uploader plus a 30-second browser poll means up to roughly 90 seconds of delay, plus upload/list/download time. Calling the upload command at pipeline completion avoids the uploader interval.

## What updates automatically

- A new nonempty `<sample>/metahopper_report.html` creates a new tab on the next successful list. Empty folders and unrelated files are ignored. Pagination supports more than 1,000 objects.
- Changing an S3 object's ETag, last-modified time, or size marks the report as changed. The selected clean tab downloads the current HTML. Other tabs load it when selected.
- Removing an object removes its tab. If that tab has manual assignments, its in-memory copy stays available with a removed-report notice so the user can export them.
- Only selected reports are downloaded. Up to four recent frames stay mounted for quick switching, plus frames with manual assignments. Evicting an older clean frame resets its report controls when reopened.
- A failed listing retains the last known sample list and visibly reports the error. A Retry button appears when it is needed. A failed HTML download has its own Retry button.
- Reports update in the background. A report with manual assignments stays protected until the user chooses to replace it; discovery of new samples continues.

The supplied report's rank controls, bin tables, plots, local FASTA selection, and downloads remain inside the report. Reports are isolated in sandboxed frames without access to the parent login credentials. External scripts, subresources, and fetch requests from report HTML are blocked, so this version expects self-contained reports like the supplied file. External assets or relative-file dependencies would need a deliberate extension.

Manual bin assignments remain local to that open browser tab. They are not saved to S3. This version detects assignments using the supplied MetaHopper report's `#exp` export button; changes in a future generator may require updating `src/frame.ts`. Exported assignments keep the tab protected until a deliberate reload or sign-out. The report-update warning asks before discarding them. Browser close warnings are best-effort; always export work you want to retain.

## Verify in AWS before client handoff

1. Sign in as a group member: list and open a report, change rank, and exercise the original report controls.
2. In a separate signed-out browser, the dashboard must require sign-in. Opening a direct, unsigned S3 object URL must return Access Denied.
3. Sign in as a test user without any supported group: no reports should be requested, and direct S3 listing/reading must fail. Confirm Cognito self-registration is disabled.
4. Upload a second sample while the viewer is open: a tab should appear after the next poll. Replace a selected report: the clean report should reload. With manual assignments present, replacement should wait for confirmation.
5. Sign in separately as Phoridae, Aphrophora, and Sample reports clients and as staff. Check each client role cannot upload/delete and cannot list/read either of the other project prefixes; staff must be able to list/read all three. The viewer UI having no upload button is not an authorization test; test the IAM-backed storage requests too.

These live checks require your AWS deployment. Local build and browser tests do not validate deployed IAM, Cognito email delivery, or S3 CORS. Amplify-managed storage supplies CORS configuration. If adapting to an existing bucket later, configure the actual Cognito group role's prefix-scoped IAM permissions and bucket CORS; changing only the frontend bucket name is insufficient.

## Dashboard header

The MAB logo occupies 30% of the viewport width on the left, with the signed-in email and Sign out button directly beneath it. The grayscale planthopper and tightly spaced Space Grotesk wordmark sit at the upper right, with the project selector (or single-project name) beneath. The two header groups stay together on narrow screens, with the account email wrapping instead of disappearing. The sign-in and project-access screens use the same branding. The font is self-hosted in `public/fonts/` with its SIL Open Font License; no external font service is used.

Sample search, sorting and scrollable tabs remain available. The redundant sample size/update strip and the generated report's top-level “bin set · rank(s) · built” subtitle are hidden. Subtitle styling is applied inside the isolated viewer, so existing S3 reports do not need to be regenerated or uploaded again. Report titles, section descriptions and biological data remain visible. Routine refresh controls stay hidden; connection errors retain Retry, and manual assignments still prevent automatic report replacement.

## Local development

Use Node.js 22 and npm 10.9.4, matching the Amplify build. After downloading the real `amplify_outputs.json` from your deployed app:

```bash
nvm install
nvm use
npm install --global npm@10.9.4
npm ci
npm test
npm run typecheck:backend
npm run build
npm run dev
```

After intentionally changing dependencies, run `npm install` with this npm version, commit both `package.json` and `package-lock.json`, and verify a fresh `npm ci` before pushing. Amplify uses `npm ci` and will reject an incomplete or inconsistent lockfile.

Alternatively, `npx ampx sandbox` with authorized AWS credentials creates a separate development backend and generates that file. This provisions AWS resources and incurs normal AWS usage charges. Do not publish client reports to a development environment unintentionally.

## Future full outputs

Reserve a separate prefix such as `outputs/phoridae/<sample>/...` in the same bucket. This keeps frequent HTML discovery away from a potentially large output tree. Full outputs are not exposed by the current access rule. Later, add explicit read permissions and a download browser for that prefix. No report data needs to be committed to GitHub.

To add another client project, add its name, group, and distinct prefix in `project.ts` and redeploy the backend and frontend. Extend the publishing principal policy if needed. Uploads create sample tabs within a configured project; they do not automatically create new client permissions.

## Upgrade an existing Phoridae deployment

1. Merge the multiple-project change and let the existing Amplify app deploy. Keep the same storage resource name and app; the bucket is not intentionally replaced.
2. Cognito will add `aphrophora-viewers` and `metahopper-admins`. Existing Phoridae memberships remain. Add the new client only to `aphrophora-viewers`. Add your own review account to `metahopper-admins`. Sign out and back in.
3. Pull the updated repository on TheBelly. Include `--prefix reports/phoridae/` in existing Phoridae scripts/timers and `--prefix reports/aphrophora/` for Aphrophora.
4. If reports were already uploaded to the wrong prefix, move only those misplaced report objects to the correct prefix. A new upload alone does not remove old copies. Until moved, anything under `reports/phoridae/` is accessible to Phoridae viewers. Previously downloaded copies cannot be recalled.
5. Perform the AWS access checks above before handing the new client their login.

## Enable access to multiple assigned projects

Merge the assigned-project access change and let the existing Amplify app deploy **both backend and frontend**. The backend adds `custom.report_group_roles` to `amplify_outputs.json`; the frontend needs these role identifiers. Existing buckets, pools, groups, memberships, and S3 permissions are retained. No new Cognito group or manual IAM edit is required.

For an account that needs both client projects, retain membership in **both `phoridae-viewers` and `aphrophora-viewers`**. After deployment, sign out and sign in again. The project selector in the header will offer Phoridae and Aphrophora. It will not offer Sample reports unless that group is also assigned. Your `metahopper-admins` account continues to show all configured projects.

Verify a report and a FASTA/annotation download in each assigned project, and confirm the account cannot list or download Sample reports. Test a single-project account and your staff account too. Freshly issued tokens and existing temporary AWS credentials have finite lifetimes; removing a membership does not retroactively revoke downloaded data or every previously issued credential/URL.

## Enable Sample reports on an existing deployment

`sample-reports` maps to `reports/sample-reports/` in the existing bucket. Its members can read only that project; `metahopper-admins` can read it too. Uploads create the S3 folder automatically, so no separate bucket or empty folder is needed.

If you already created `sample-reports` manually in Amplify User management, resolve that name conflict **before merging/deploying this change**. Amplify needs to create and manage the group with its storage role; it does not automatically adopt the manually created group.

1. In **Amplify → metahopper-live → main → Authentication → Groups**, open the manually created `sample-reports` group. Record every member so you can restore the memberships. If it has a custom IAM role or is used by another app, preserve that configuration and plan an import instead of deleting it.
2. For this manually created portal-only group, delete **only the `sample-reports` group** after recording its members. This removes its memberships, not the user accounts or S3 reports. Leave the other groups, user pool, and identity pool in place.
3. Merge this change and wait for the existing Amplify deployment to succeed. It recreates `sample-reports` with the correct read-only storage permissions.
4. Add the recorded/intended users to the recreated group. Clients can belong to multiple assigned project groups; use `metahopper-admins` only for staff who need all projects. Sign out and back in to refresh access.
5. Upload reports using the command below and perform the AWS access checks above. If TheBelly uses the restricted publishing policy template, update that IAM policy to include the new prefix too.

```bash
PYTHONNOUSERSITE=1 python3 "$HOME/bin/metahopper-live/scripts/publish_reports.py" \
  --source "/absolute/path/to/directory-containing-sample-folders" \
  --bucket YOUR_GENERATED_BUCKET_NAME \
  --prefix reports/sample-reports/ \
  --dry-run
```

Replace `--source` with the parent directory of sample folders, for example a directory containing `Sample01/metahopper_report.html` and `Sample02/metahopper_report.html`. Remove `--dry-run` to upload. This leaves any copies previously uploaded under other prefixes in place; those copies retain their existing access permissions.

## Validation performed

Assigned-project access update (2026-11-14): 27 automated tests, the backend TypeScript check, production frontend build, offline CDK policy/output checks, and a fresh npm 10.9.4 `npm ci` passed. AWS SDK transport tests exercise actual request serialization/signing with mocked HTTP responses for both client roles, staff, report/asset URLs, cancellation, and unassigned-project rejection. Browser automation could not launch in the validation environment because Chromium socket creation was denied; live browser/Cognito/S3 checks remain required after deployment. No AWS memberships or report objects were changed.

Sample reports update (2026-10-30): production frontend build, backend TypeScript check, seven unit tests, and offline AWS policy synthesis passed using the available Node.js 24 environment. The checks cover each client prefix, staff access to all three projects, unchanged group precedence, public-access blocking, and invitation-only signup. The build used temporary placeholder outputs only; live login and AWS authorization must be checked after deployment. Dependency manifests and the lockfile are unchanged.

Multiple-project update (2026-10-22): production build, backend typecheck, seven unit tests, uploader destination checks, and browser tests for both clients, unassigned users, staff switching, edit confirmation, late-response isolation, and mobile layout passed. Run `node --import tsx tests/permissions.check.ts` for offline synthesis checks of client/staff storage policy scopes, role precedence, blocked public/guest access, and invitation-only signup. This creates local CDK output only; it does not contact AWS or deploy. Live IAM access still needs the per-account checks above.


Validated on 2026-10-19 using Node.js 24, React 19, Amplify JS 6.22.2, Amplify UI 6.15.7, Amplify Backend 1.25.1, and Vite 6.4.4. The lockfile records exact dependencies.

- Production frontend build and backend TypeScript check pass.
- Five automated tests cover prefix filtering, pagination, same-size replacements, cancellation, and report isolation markup.
- Chromium tests used the supplied SPH1014 HTML with mocked S3 listings: rank filtering, cached sample state, timed discovery, report replacement, pause/resume, removal, failure/retry, real lasso assignment, TSV download, and manual-edit protection passed. Parent DOM access from the report frame was blocked. Desktop and narrow mobile layouts were checked.
- The login UI renders without signup. Authentication itself and the deployed AWS permissions remain unverified until deployment.
- The publisher's staging selection was checked with mocked AWS CLI calls: only report HTML was selected, and remote deletion was not requested.

No AWS resources were provisioned, no invitations sent, and no report data published during this validation.

## Taxonomic search across samples

The dashboard's **Search taxa across samples** field searches bin names within
the selected project. It shows the sample, matched rank, bin size, contig count,
N50, completeness and contamination. Click a result to open and highlight that
bin in its sample report. Results can be filtered by rank and paged; missing
quality values appear as a dash. Domain assignments such as
`unclassified_Bacteria` remain searchable; generic unbinned buckets do not.

Pull both the updated MetaHopper generator and this viewer/publisher. Republish
existing samples using the normal command (omit `--skip-refresh` the first time):

```bash
conda run --no-capture-output -n metahopper-lean \
  python ~/bin/metahopper-live/scripts/publish_reports.py \
  --source /data/samples --pipeline-dir ~/bin/MetaHopper \
  --bucket YOUR_GENERATED_BUCKET_NAME --prefix reports/phoridae/ \
  --graph-max-nodes 4000000 --megahit-max-links 10000000
```

Use `reports/aphrophora/` for that project and repeat `--sample Sample01` to
select particular sample folders. Publication regenerates reports and graph
catalogues using saved outputs; it does not run CheckM or the assembly pipeline.
For missing quality, first run MetaHopper's `metahopper_postprocess.py
--checkm-only` as documented in that repository.

The generator embeds compact bin summaries. The publisher uploads immutable
assets first, HTML with S3 PutObject second, and a small JSON index at
`<sample>/taxonomy/<report-etag>.json` last. It uses the ETag returned by the
upload. A new report cannot select an old index. Index publication uses existing
write permissions; no S3 read or new client permissions are required. Size-only
sync applies to content-hashed asset keys so identical large graph/FASTA files
are not retransferred. The mutable manifest and HTML are uploaded separately.

The app discovers only an index matching the current report ETag and loads at
most four small indexes concurrently when a search starts. It caches them per
report version, cancels on project changes, and displays index coverage and
failures. Older reports without an index continue to open and explicitly count
as needing republishing. No multi-megabyte HTML scans or additional backend
database are needed. Search uses the existing project IAM roles and does not
search projects outside the user's selected authorized project.

Validation: 34 dashboard tests, 25 publisher tests, TypeScript/Vite build,
109 MetaHopper Python tests, and report/graph/annotation JavaScript interaction
checks passed. Browser file previews were blocked by the workspace's URL policy;
SVGs and report interactions were additionally checked in an offline DOM.

## References

- [Amplify group-based storage rules](https://docs.amplify.aws/react/build-a-backend/storage/authorization/)
- [Listing and pagination](https://docs.amplify.aws/react/frontend/storage/list-files/)
- [Authenticated report downloads](https://docs.amplify.aws/react/frontend/storage/download-files/)
- [Cognito administrator-created users](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-admin-create-user-policy.html)
- [Amplify backend build commands](https://docs.amplify.aws/react/deploy-and-host/fullstack-branching/custom-pipelines/)
