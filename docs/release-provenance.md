# Release tag provenance

Every published release tag must resolve to the exact Git commit checked out by
the build job. The assets, OTA manifests, source archives, and Git tag are one
provenance record; publishing stops if any part points at a different commit.

`release.sh` derives the source commit from `git rev-parse HEAD`, passes that
full SHA to `gh release create --target`, and verifies the remote tag before it
uploads an asset. This deliberately does not use the repository's default
branch.

## Known exception: 1.121.04107

The 1.121.04107 release predates the provenance guard and is inconsistent:

| Record | Commit |
| --- | --- |
| Build run 32033647609 and published assets | `e4385b4747db43391d3efa25ecb6a1abdf67ed66` |
| Git tag `1.121.04107` | `08a22ee74e6242a918d006e2c5be099f8fd9a050` |

The shipped binaries contain the launch-intent/openExternal fix from `e4385b4`.
Checking out the published tag does **not** reproduce those binaries. Debuggers
must use `e4385b4747db43391d3efa25ecb6a1abdf67ed66` for this release.

Do not move or recreate the published tag without Thomas's explicit decision.
No retag or republish was performed as part of the provenance fix.

## Prepared correction proposal — not authorized

If Thomas decides that correcting public history is preferable to preserving
the existing tag, the change must be handled as a separately approved release
operation. The proposed operation is:

1. Record the current release JSON, tag ref, asset names, sizes, and checksums.
2. Confirm the target commit is exactly
   `e4385b4747db43391d3efa25ecb6a1abdf67ed66`.
3. Force-update `refs/tags/1.121.04107` to that commit and update the release's
   target metadata to the same full SHA.
4. Re-read both refs through the GitHub API and verify every existing asset is
   unchanged.
5. Publish a provenance note stating that the tag was corrected after release.

The exact proposed operation is recorded below for review. **Do not run it
without a new, explicit approval from Thomas:**

```bash
release_repo="SSslider/solstice"
release_tag="1.121.04107"
correct_source_sha="e4385b4747db43391d3efa25ecb6a1abdf67ed66"

# Preconditions: archive API output/assets first and confirm the current ref is
# exactly 08a22ee74e6242a918d006e2c5be099f8fd9a050.
gh api --method PATCH \
  "repos/${release_repo}/git/refs/tags/${release_tag}" \
  --field "sha=${correct_source_sha}" \
  --field force=true
gh release edit "${release_tag}" \
  --repo "${release_repo}" \
  --target "${correct_source_sha}"
```

Moving a published tag is destructive public-history rewriting and remains
blocked on Thomas's explicit approval.
