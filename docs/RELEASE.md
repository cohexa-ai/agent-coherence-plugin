# Release Playbook

Operator runbook for cutting a release of the `agent-coherence` Claude Code plugin.

This document is intentionally copy-pasteable. Each fenced block is the exact command an operator runs. Run them in order; do not paraphrase.

The repository uses a two-branch model:

| Branch | Role |
|---|---|
| `main` | Release target. Tagged for `v*` releases. Protected. |
| `dev` | Integration branch for in-flight features. Protected (status checks only, no review required). |

Feature work happens on topic branches (`feat/*`, `fix/*`, `docs/*`, `refactor/*`) which target `dev`. Releases are cut by merging `dev → main` and tagging the merge commit on `main`.

---

## 1. Pre-flight (one-time setup)

These commands set up the `dev` integration branch and the branch/tag protection rules. Run them once when bootstrapping the repository (or when re-bootstrapping after an admin reset). `tools/check_release_readiness.js` verifies this configuration — it is the document these commands are checked against, both manually before a tag push and in the `preflight` job of `.github/workflows/release.yml`.

You need:

- `gh` authenticated as a repo admin
- A clean local checkout of this repository

### Create the `dev` integration branch on origin

```bash
git checkout main && git pull --ff-only origin main
git checkout -b dev && git push -u origin dev
```

### Configure branch protection on `main`

Require PR review + the CI status check contexts. Strict mode means the PR branch must be up to date with `main` before merging.

The context names below MUST match the job display names in `.github/workflows/ci.yml` verbatim — GitHub matches on the `name:` field of each job (and per-matrix variant). Update this list if the workflow's job names change. `node tools/check_release_readiness.js` verifies the live required contexts against ci.yml and fails on drift (a stale context blocks every PR merge behind an admin override), so run it after any matrix or job-name change and re-apply these PUT commands with the new names.

```bash
gh api -X PUT repos/Cohexa-ai/agent-coherence-plugin/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Typecheck", "Tests (Node 22)", "Tests (Node 24)", "Tests (Node 25)", "Zero-Python install (Node 22)", "Zero-Python install (Node 24)", "Zero-Python install (Node 25)", "Marketplace-shaped provision (dist-less package)", "Build Package"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null
}
JSON
```

`required_approving_review_count: 1` is kept deliberately even though it cannot be satisfied today. The repository has a single collaborator, who is therefore the author of every `dev → main` PR, and GitHub refuses self-approval — no review can ever land on a release PR. Keeping the rule means the gate is already in place the day a second maintainer joins, and it is precisely why `enforce_admins` is `false`: releases merge past it with `--admin` (see §2). `tools/check_release_readiness.js` does not assert this field, so changing it will not trip preflight — which also means nothing keeps the doc and the live branch in sync automatically. If you drop the requirement, drop it from this payload and from the live branch in the same change.

### Configure branch protection on `dev`

Require the same status check contexts. No review required — `dev` is a fast-moving integration branch.

```bash
gh api -X PUT repos/Cohexa-ai/agent-coherence-plugin/branches/dev/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Typecheck", "Tests (Node 22)", "Tests (Node 24)", "Tests (Node 25)", "Zero-Python install (Node 22)", "Zero-Python install (Node 24)", "Zero-Python install (Node 25)", "Marketplace-shaped provision (dist-less package)", "Build Package"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

### Configure the `protect-main` branch ruleset

`main` is protected by **two independent systems**, and both must pass. This is the single most confusing thing about this repository's configuration, so read this before debugging any "why won't this merge" question:

| Layer | Configured by | Admin bypass |
|---|---|---|
| Classic branch protection | `/branches/main/protection` (above) | via `enforce_admins: false` |
| `protect-main` ruleset | `/rulesets` (below) | via the ruleset's own bypass list |

**A ruleset bypass actor does not exempt you from classic branch protection, and vice versa.** They are evaluated separately. A PR showing "Review required" while you hold ruleset bypass is being blocked by the *classic* layer.

The ruleset's bypass list must contain **Repository admin** (`bypass_mode: always`); without it, no release can merge, because the review requirement above is unsatisfiable. Bypass actors are not settable through this endpoint's payload — add them in **Settings → Rules → protect-main → Bypass list**, and verify with:

```bash
gh api repos/Cohexa-ai/agent-coherence-plugin/rulesets --jq '.[] | select(.name=="protect-main") | .id' \
  | xargs -I{} gh api repos/Cohexa-ai/agent-coherence-plugin/rulesets/{} \
    --jq '{methods: (.rules[]|select(.type=="pull_request")|.parameters.allowed_merge_methods), rules: [.rules[].type], bypass: [.bypass_actors[].actor_type]}'
```

**`allowed_merge_methods` must include `merge`, and `required_linear_history` must NOT be present.** §2 step 2 merges the release with a merge commit; a squash-only ruleset makes that procedure unexecutable, and `required_linear_history` forbids merge commits outright. v0.4.0 shipped with the ruleset in exactly that state, which is why it was squash-merged and why `dev` then needed a manual reconcile (PR #112) — the recurring conflict §2 step 2 warns about. To correct it:

```bash
gh api -X PUT repos/Cohexa-ai/agent-coherence-plugin/rulesets/$(gh api repos/Cohexa-ai/agent-coherence-plugin/rulesets --jq '.[] | select(.name=="protect-main") | .id') \
  --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "pull_request", "parameters": {
      "allowed_merge_methods": ["merge", "squash"],
      "dismiss_stale_reviews_on_push": false,
      "dismissal_restriction": {"allowed_actors": [], "enabled": false},
      "require_code_owner_review": false,
      "require_extra_approval_for_unattributed_changes": true,
      "require_last_push_approval": false,
      "required_approving_review_count": 1,
      "required_review_thread_resolution": true,
      "required_reviewers": []
    }}
  ]
}
JSON
```

Nothing verifies this automatically — `tools/check_release_readiness.js` checks the *tag* ruleset (below), not this one. If a release merge is ever rejected on merge method, this is the cause.

### Configure tag protection ruleset for `refs/tags/v*`

Only admins can push release tags. Deletion and non-fast-forward updates are blocked.

```bash
gh api -X POST repos/Cohexa-ai/agent-coherence-plugin/rulesets \
  --input - <<'JSON'
{
  "name": "Protect v* release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"}
  ]
}
JSON
```

### Create the forward-merge GitHub App

`.github/workflows/forward-merge-main.yml` merges `main` into `dev` whenever `main` holds commits `dev` lacks: Dependabot security updates (they always target the default branch), the release merge and bump (§2), and hot-fixes (§3). It needs a GitHub App token rather than `GITHUB_TOKEN`, because `GITHUB_TOKEN` cannot push changes to `.github/workflows/`, its PRs get their checks held for manual approval, and its merges fire no push workflows. The workflow header has the detail.

The App's private key goes in an **environment** that only `main` may use, not in a repository secret. The App can push workflows and approve PRs, and an approval from it would count toward `main`'s one required review. A repository secret is readable by a workflow running from any branch, including `dev`, which takes merges with no review.

1. Create the App at <https://github.com/organizations/Cohexa-ai/settings/apps/new>. Any unique name. Untick **Webhook → Active**. Repository permissions: **Contents**, **Pull requests** and **Workflows**, each *Read and write* (Metadata read-only is added automatically). Where can it be installed: *Only on this account*.
2. **Install App** → *Only select repositories* → `agent-coherence-plugin`.
3. On the App's settings page, copy the **Client ID**, then **Generate a private key** (a `.pem` downloads).
4. Create the `forward-merge` environment and limit it to `main`:

   ```bash
   gh api -X PUT repos/Cohexa-ai/agent-coherence-plugin/environments/forward-merge --input - <<'JSON'
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   JSON
   gh api -X POST repos/Cohexa-ai/agent-coherence-plugin/environments/forward-merge/deployment-branch-policies \
     -f name=main -f type=branch
   ```

   `protected_branches: true` would not do: it admits every protected branch, and `dev` is protected. Run these even if the environment already exists: GitHub creates a referenced environment with no branch policy, and so does the web UI by default. The workflow refuses to use the environment unless it admits exactly `main`. Never store the key as a repository secret; any workflow on any branch can read one.
5. Store the Client ID as a repository variable and the key as an environment secret, then delete the `.pem`:

   ```bash
   gh variable set FORWARD_MERGE_APP_CLIENT_ID -R Cohexa-ai/agent-coherence-plugin --body '<client id>'
   gh secret set FORWARD_MERGE_APP_PRIVATE_KEY -R Cohexa-ai/agent-coherence-plugin --env forward-merge < path/to/key.pem
   ```

6. Verify, once the workflow file is on `main`: `gh workflow run forward-merge-main.yml -R Cohexa-ai/agent-coherence-plugin --ref main` and expect a green run. A manual run always mints the App token, so green means the App and the environment work even when `dev` has nothing to take. A dispatch with `--ref dev` fails at the environment's branch policy; that is the protection working.

Do not add the App to any bypass list. Its PR merges only once `dev`'s required checks pass, which is the point. Until the App exists, the workflow stays green while `dev` contains `main`, and fails red, naming this section, only when `dev` is behind.

Keeping the key on `main` stops the App from being used to approve PRs, but it is not the only approval source. While **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** is on, any workflow that declares `pull-requests: write` can approve a PR with `GITHUB_TOKEN`, and that approval counts toward `main`'s one required review. Since Dependabot version updates target `dev`, the setting serves only `dependabot-automerge.yml`'s best-effort approval of devDependency security PRs on `main`, and those can wait for a human.

### Verify

```bash
node tools/check_release_readiness.js
```

Expect: six `✓` lines and exit 0 (`0 failure(s), 0 warning(s)`).

---

## 2. Per-release procedure

Replace `X.Y.Z` with the target version (e.g. `0.3.2`) throughout.

**Read this before you start: the release merge requires `--admin`.** `main` requires one approving review (§1), and that requirement is structurally unsatisfiable in this repository — the single collaborator authors every release PR, and GitHub refuses self-approval. `enforce_admins: false` is set deliberately so an admin can merge past it. Be aware of what that costs: `--admin` bypasses *all* of `main`'s protection, not just the review gate — required status checks and the strict up-to-date rule are skipped too. Step 1's "verify CI is green" is therefore a hard gate rather than a courtesy; it is the only thing checking CI on the release merge.

1. **Open the `dev → main` PR.** Title is `release: vX.Y.Z` so it's easy to find in the PR history.

   ```bash
   gh pr create --base main --head dev --title "release: vX.Y.Z"
   ```

   Note the PR number it prints — `<N>` in step 2.

   Verify CI is green on every required job (the contexts list in §1) before continuing. Nothing enforces this for you: the `--admin` merge in step 2 skips the required status checks.

2. **Merge with a merge commit, as an admin.** The tag in step 7 points at `main`'s merge commit, whose tree is identical to `dev`'s tip. The tag does *not* point at a SHA that already existed on `dev`, and cannot be made to — see below.

   ```bash
   gh pr merge <N> --admin --merge
   ```

   **Do not use `--rebase`.** Every topic branch lands on `dev` through a PR merge, so `dev` always carries merge commits — the v0.4.0 release PR carried 19 — and GitHub cannot rebase a branch that contains them. The attempt fails with:

   ```
   GraphQL: This branch can't be rebased (mergePullRequest)
   ```

   Confirmed on the v0.4.0 release, 2026-08-23. Preserving `dev`'s commit SHAs on `main` is not achievable under this branching model, so the tag identifies the release by tree, not by SHA lineage.

   **Do not use `--squash` either.** It would collapse the release into a single commit with no ancestry link to `dev`, permanently diverging the two branches and turning §3's forward-merge into a recurring conflict. This is not hypothetical: v0.4.0 was squash-merged, and the next forward-merge came back as `add/add` conflicts across every file the release touched, needing a hand-resolved reconcile (PR #112).

   **If the merge is rejected on merge method**, the `protect-main` ruleset is squash-only — fix it per §1 before continuing. That is the state v0.4.0 shipped in.

3. **Sync local `main`.**

   ```bash
   git checkout main && git pull --ff-only origin main
   ```

4. **Bump the version in three places.** All three must stay in sync — verify with `node tools/check_versions_synced.js`, which exits 1 with a diff on drift.

   - `package.json` → `"version": "X.Y.Z"`
   - `.claude-plugin/plugin.json` → `"version": "X.Y.Z"`
   - `.claude-plugin/marketplace.json` → `plugins[0].version` (note the array path: it's nested inside the first entry of the `plugins` array, not at the manifest root)

5. **Regenerate the lockfile (recommended).** Keeps `package-lock.json`'s own `"version"` field aligned with the bump.

   ```bash
   npm install --package-lock-only
   ```

6. **Commit and push.**

   ```bash
   git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json package-lock.json
   git commit -m "chore(release): bump to vX.Y.Z"
   git push origin main
   ```

   Each push to `main` here and the merge in step 2 starts `forward-merge-main.yml`, which opens a PR merging `main` into `dev` and merges it once `dev`'s checks pass. Confirm it lands before the next release. If it fails on a conflict, merge by hand per §3 step 5.

7. **Create the annotated tag.** Use `-a` so the tag carries metadata (tagger, date, message) — lightweight tags are harder to audit.

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z: <one-line summary>"
   ```

8. **Push the tag.**

   ```bash
   git push origin vX.Y.Z
   ```

9. **Watch the Actions tab.** The tag push triggers `release.yml`, which runs three jobs:

   - **preflight** — verifies the tag format and runs `tools/check_release_readiness.js` against the §1 GitHub configuration
   - **build** — `npm ci`, typecheck, test, build, SBOM generation
   - **github-release** — creates the GitHub Release with the build artifacts attached

   Common failure modes:

   - **Preflight fails:** usually means the tag name doesn't match `vX.Y.Z`, or the §1 branch/tag protection drifted (re-run the §1 commands).
   - **Build fails on version check:** the tag's version doesn't match `package.json`'s `"version"` field. Re-check step 4.

10. **Smoke check from a fresh install.** From a clean `claude` install (no prior marketplace state):

    ```bash
    claude
    # inside Claude Code — un-pinned (canonical) form; resolves to the
    # latest published tag:
    /plugin marketplace add Cohexa-ai/agent-coherence-plugin
    /plugin install agent-coherence@agent-coherence
    ```

    For operators who need to pin a specific version (CI / reproducibility), use:

    ```bash
    /plugin marketplace add Cohexa-ai/agent-coherence-plugin@vX.Y.Z
    ```

    Confirm the plugin loads (no errors on `SessionStart`, hooks visible in `/hooks`).

11. **Broad-beta gates (any tag introducing a new public surface).** Walk through the BB1–BB8 rubric in the broad-beta playbook (`docs/BROAD_BETA.md`, maintainer-local — kept out of public tracking) before pushing the tag. That playbook also covers the 14-day post-launch monitoring window and the rollback runbook. Skip this step for patch tags that only fix regressions in already-shipped behavior.

---

## 3. Hot-fix procedure

Use this when a critical security or correctness fix must land on `main` immediately, bypassing the `dev` integration step.

1. **Branch from `main`** (not `dev` — `dev` may contain unreleased work you don't want to ship with the hot-fix):

   ```bash
   git checkout main && git pull --ff-only origin main
   git checkout -b hotfix/<short-name>
   ```

2. **Apply the fix, push, open PR against `main`.** Note in the PR body that this is a hot-fix bypassing the `dev` integration step so reviewers understand why it isn't coming through the normal path.

   ```bash
   git push -u origin hotfix/<short-name>
   gh pr create --base main --title "fix: <short summary>" --body "Hot-fix bypassing dev. <reason>."
   ```

3. **Merge after CI green + review.** Same protection rules as a normal release PR — the merge cannot bypass required status checks.

4. **Tag if a release is warranted.** Follow section 2 steps 4–10 (version bump, commit, tag, push tag, smoke check).

5. **Forward-merge into `dev`.** Critical — otherwise the next `dev → main` PR will look like it's re-introducing the hot-fix as a divergence (or worse, revert it during a rebase).

   `forward-merge-main.yml` does this automatically once the hot-fix merges: it opens a PR merging `main` into `dev` and merges it after `dev`'s checks pass. Run the commands below only when that workflow fails on a conflict. If you resolve through a PR instead, use any branch except `chore/auto-forward-merge-main`, which the workflow rebuilds from scratch:

   ```bash
   git checkout dev && git pull --ff-only origin dev
   git merge main
   git push origin dev
   ```

---

## 4. Upgrade procedure — MANDATORY `hook.secret` rotation on v0.2 (KTD-W)

When an operator upgrades from v0.1.x to v0.2.x (or any future tag that changes the threat model under which the bearer token was issued), the `hook.secret` MUST be rotated before strict-mode hard guardrails take effect. Secrets generated under the old threat model are insufficient to bridge the upgrade — the canonical rationale is in the v0.2 plan KTD-W.

This is an OPERATOR step, not an automated one. The plugin cannot rotate the secret on the operator's behalf without disrupting in-flight `claude` sessions; the operator is the only authority that can decide when it's safe.

### Procedure

```bash
# 1. Stop ALL running `claude` sessions in the workspace.
#    The coordinator is lazy-spawned per-workspace; it will exit when no
#    sessions hold open hook clients.

# 2. Verify no coordinator process is still alive.
cd <repo>
cat .coherence/server.pid 2>/dev/null
# If a PID is listed, kill it:
kill $(head -1 .coherence/server.pid) 2>/dev/null

# 3. Remove the old secret.
rm .coherence/hook.secret

# 4. Restart any `claude` session in the workspace. The first PreToolUse
#    hook fires, which spawns the coordinator, which generates a fresh
#    32-byte secret at .coherence/hook.secret (mode 0o600).

# 5. Verify the new secret landed.
ls -la .coherence/hook.secret
# Expect: -rw------- (mode 0o600), size 64 bytes (32 hex-encoded bytes).

# 6. Confirm hooks fire under the new secret.
#    Python backend:
agent-coherence-status --self-test
# Expect: exit 0, 4 steps green.
#    Node backend (the default for fresh workspaces since v0.3.1):
#    `--self-test` is Python-only — the Node CLI rejects it with exit 2.
#    Run the plain status command instead and confirm the coordinator
#    answers with workspace status:
agent-coherence-status
```

### Why this is mandatory, not advisory

v0.1.1's threat model treated the bearer secret as protection against Adversary 1 (same-user co-tenant code) only. v0.2's strict-mode hard guardrails (`permissionDecision: "deny"`) extend the trust boundary the secret protects — a leaked v0.1.1 secret used by a same-user adversary in v0.2 could trigger denials the operator never intended, undermining the operator's strict-mode policy. Rotating ensures the operator's v0.2 deployment runs entirely under a secret minted under v0.2's threat assumptions.

### Hot rotation deferred

`agent-coherence-coordinator --rotate-secret` (rotate without stopping sessions) is a v0.2.x backlog item. v0.2 ships the manual stop-rotate-restart path documented above.

---

## Notes

### Why no `npm publish`?

`package.json` is marked `"private": true`. The plugin is consumed via `/plugin marketplace add Cohexa-ai/agent-coherence-plugin@vX.Y.Z`, which clones the tagged Git ref directly — not via the npm registry. The Node coordinator artifact is built into `dist/` on each user's machine at provisioning time, so there's nothing to publish to a package registry.

### Why SBOM in releases?

Supply-chain transparency. The release attaches a CycloneDX JSON SBOM generated by `@cyclonedx/cyclonedx-npm` in `release.yml`'s `build` job. Operators downloading a release can verify the dependency tree they're getting matches what the build produced.

### Why no Trusted Publishers OIDC?

Trusted Publishers OIDC is for publishing to PyPI/npm without a long-lived API token. Since we don't publish to a package registry (see above), there's no token to protect. The release artifact lives only on GitHub Releases, and `softprops/action-gh-release@v2` uses the auto-provisioned `GITHUB_TOKEN`, which is already scoped per-workflow and can't escape the action's run.
