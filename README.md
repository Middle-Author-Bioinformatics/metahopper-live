# MetaHopper live report portal

A small Amplify Gen 2 app that gives invited clients a searchable, scrollable row of sample tabs. Each tab runs the original MetaHopper HTML report. The interface lists a private S3 prefix every 30 seconds while the page is visible, plus on focus and manual refresh. No manifest generation or site redeployment is needed when reports change.

This is a separate app based on the login approach in [your upload portal](https://github.com/Middle-Author-Bioinformatics/sample-amplify-storage-browser). It creates its own Cognito user pool and S3 bucket. It does not change the upload portal or share its existing user accounts.

## Deploy once

1. Create a **private GitHub repository** named, for example, `metahopper-reports`. Unzip this project and commit its source at the repository root, including `package-lock.json`. Do not commit report HTML, pipeline data, credentials, `node_modules`, `dist`, or `amplify_outputs.json`.
2. In AWS Amplify, choose **Create new app**, connect that repository, and select its production branch. Use the included `amplify.yml` and an Amplify service role with the standard permissions needed to deploy Gen 2 backends. The build selects Node.js 22 and npm 10.9.4 automatically. Deploy. This creates the login resources, private bucket, and hosted frontend. The initial deployment can take several minutes.
3. From the deployed branch's backend outputs, record `auth.user_pool_id`, `storage.bucket_name`, and the AWS region. You can download `amplify_outputs.json` from Amplify or run `npx ampx generate outputs --app-id YOUR_APP_ID --branch main` with authorized AWS credentials. Use the **actual generated bucket name**, not its friendly label `metahopperReports`.
4. Open that user pool in Cognito. Create your own user, then your client's user, using email addresses and temporary passwords. Add each to the **`phoridae-viewers`** group. Users set a new password on first sign-in. Self-registration is disabled in Cognito as well as hidden in the UI. Users without this group cannot read reports. Cognito can send invitation emails when you create users; choose that deliberately in the console.
5. Publish a report using the instructions below. Open the Amplify HTTPS URL, sign in, and verify the report and controls. Share that URL with the invited client once the access checks below pass.

The sign-in page is reachable on the web; report contents and sample listings require authorized login. S3 public access is blocked and unauthenticated identity access is disabled. No S3 website endpoint is needed. Client credentials are temporary, read-only credentials scoped to the project prefix. Do not add public bucket policies or a `guest`/`authenticated` read rule.

## Publish from TheBelly

The default project settings live in `project.ts`:

| Setting | Value |
| --- | --- |
| Display name | Phoridae |
| Reader group | `phoridae-viewers` |
| S3 report prefix | `reports/phoridae/` |
| Poll interval | 30 seconds while the dashboard is visible |

Each completed report has this S3 key:

```text
reports/phoridae/SPH1014/metahopper_report.html
reports/phoridae/SPH1870/metahopper_report.html
```

Install AWS CLI v2 on TheBelly and configure an authorized profile, for example `mab-reports`. The supplied `scripts/belly-iam-policy.json` is an IAM identity-policy template for its publishing principal. Replace both bucket placeholders. It permits listing this prefix and writing reports, with no read or delete permission. Use your normal AWS credential setup; never place AWS access keys in GitHub or frontend variables.

Copy `scripts/publish_reports.py` to TheBelly. It finds only immediate sample folders, stages just their report HTML files, then uses S3 sync to upload new or locally newer/size-changed files. It does not upload FASTQ, FASTA, bins, or other outputs, and does not delete remote reports.

```bash
python3 scripts/publish_reports.py \
  --source "$HOME/Jagiellonian/Phoridae" \
  --bucket YOUR_GENERATED_BUCKET_NAME \
  --profile mab-reports \
  --dry-run
```

Remove `--dry-run` to publish. Run after each pipeline batch completes. If a rerun deliberately preserves an old file modification time and file size, `aws s3 sync` may skip it; touch the completed HTML before publishing or use `aws s3 cp` for that report.

For one completed sample, this command is enough:

```bash
aws --profile mab-reports s3 cp \
  SPH1014/metahopper_report.html \
  s3://YOUR_GENERATED_BUCKET_NAME/reports/phoridae/SPH1014/metahopper_report.html \
  --content-type 'text/html; charset=utf-8' \
  --cache-control no-store
```

Upload after the HTML has finished writing. The staging helper detects changes during copying, but cannot know whether a pipeline has paused partway through a report. Ideally your pipeline writes a temporary filename and renames it to `metahopper_report.html` only when complete.

For periodic publication, use cron or a systemd timer on TheBelly to run the same helper after completed reports are available. Prevent overlapping runs, for example with `flock`. A one-minute uploader plus a 30-second browser poll means up to roughly 90 seconds of delay, plus upload/list/download time. Calling the upload command at pipeline completion avoids the uploader interval.

## What updates automatically

- A new nonempty `<sample>/metahopper_report.html` creates a new tab on the next successful list. Empty folders and unrelated files are ignored. Pagination supports more than 1,000 objects.
- Changing an S3 object's ETag, last-modified time, or size marks the report as changed. The selected clean tab downloads the current HTML. Other tabs load it when selected.
- Removing an object removes its tab. If that tab has manual assignments, its in-memory copy stays available with a removed-report notice so the user can export them.
- Only selected reports are downloaded. Up to four recent frames stay mounted for quick switching, plus frames with manual assignments. Evicting an older clean frame resets its report controls when reopened.
- A failed listing retains the last known sample list and visibly reports the error. Refresh retries it. A failed HTML download has its own Retry button.
- “Pause report updates” keeps the current report stable while reviewing it; discovery of new samples continues.

The supplied report's rank controls, bin tables, plots, local FASTA selection, and downloads remain inside the report. Reports are isolated in sandboxed frames without access to the parent login credentials. External scripts, subresources, and fetch requests from report HTML are blocked, so this version expects self-contained reports like the supplied file. External assets or relative-file dependencies would need a deliberate extension.

Manual bin assignments remain local to that open browser tab. They are not saved to S3. This version detects assignments using the supplied MetaHopper report's `#exp` export button; changes in a future generator may require updating `src/frame.ts`. Exported assignments keep the tab protected until a deliberate reload or sign-out. The report-update warning asks before discarding them. Browser close warnings are best-effort; always export work you want to retain.

## Verify in AWS before client handoff

1. Sign in as a group member: list and open a report, change rank, and exercise the original report controls.
2. In a separate signed-out browser, the dashboard must require sign-in. Opening a direct, unsigned S3 object URL must return Access Denied.
3. Sign in as a test user outside `phoridae-viewers`: listing and reading must fail. Confirm Cognito self-registration is disabled.
4. Upload a second sample while the viewer is open: a tab should appear after the next poll. Replace a selected report: the clean report should reload. With manual assignments present, replacement should wait for confirmation.
5. Check the client role cannot upload/delete and cannot list/read another project prefix. The viewer UI having no upload button is not an authorization test; test the IAM-backed storage requests too.

These live checks require your AWS deployment. Local build and browser tests do not validate deployed IAM, Cognito email delivery, or S3 CORS. Amplify-managed storage supplies CORS configuration. If adapting to an existing bucket later, configure the actual Cognito group role's prefix-scoped IAM permissions and bucket CORS; changing only the frontend bucket name is insufficient.

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

This version is for one client project. Other client projects need separate group-to-prefix authorization, not just a project dropdown. A separate app/backend is also a straightforward isolation choice.

## Validation performed

Validated on 2026-10-19 using Node.js 24, React 19, Amplify JS 6.22.2, Amplify UI 6.15.7, Amplify Backend 1.25.1, and Vite 6.4.4. The lockfile records exact dependencies.

- Production frontend build and backend TypeScript check pass.
- Five automated tests cover prefix filtering, pagination, same-size replacements, cancellation, and report isolation markup.
- Chromium tests used the supplied SPH1014 HTML with mocked S3 listings: rank filtering, cached sample state, timed discovery, report replacement, pause/resume, removal, failure/retry, real lasso assignment, TSV download, and manual-edit protection passed. Parent DOM access from the report frame was blocked. Desktop and narrow mobile layouts were checked.
- The login UI renders without signup. Authentication itself and the deployed AWS permissions remain unverified until deployment.
- The publisher's staging selection was checked with mocked AWS CLI calls: only report HTML was selected, and remote deletion was not requested.

No AWS resources were provisioned, no invitations sent, and no report data published during this validation.

## References

- [Amplify group-based storage rules](https://docs.amplify.aws/react/build-a-backend/storage/authorization/)
- [Listing and pagination](https://docs.amplify.aws/react/frontend/storage/list-files/)
- [Authenticated report downloads](https://docs.amplify.aws/react/frontend/storage/download-files/)
- [Cognito administrator-created users](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-admin-create-user-policy.html)
- [Amplify backend build commands](https://docs.amplify.aws/react/deploy-and-host/fullstack-branching/custom-pipelines/)
