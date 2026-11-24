# NumericBridge Site

Static frontend for [numericbridge.com](https://numericbridge.com/). This
repository contains HTML, JavaScript, CSS and image assets. Published record,
evidence and search-index bytes are maintained separately in the
[NumericBridge repository](https://github.com/FreedomIntelligence/NumericBridge).
Do not copy the catalog or any private submissions into this repository.

The canonical project's site build assembles a pinned version of this frontend
with its published catalog. Keep relative data and evidence URLs same-origin.
Frontend updates are deployed by updating the reviewed frontend revision in the
canonical project. The public MCP and private review service deploy separately.

The Upstream Contributions cards and Side Peek can augment their published
`upstream.json` records with an optional anonymous, same-origin `GET` of
`/data/public-pr-status.json`. Schema version `1` uses a UTC `refreshed_at` and
a `pull_requests` object keyed by canonical GitHub pull request URLs; each
entry has `state`, `checks`, `updated_at`, and `fetched_at`. Only URLs already
in the published contribution catalog can match. The snapshot is stale when
either `refreshed_at` or the entry’s `fetched_at` is at least 15 minutes old.
While the upstream page is visible, the browser checks for a new snapshot
once per minute.
Missing or invalid data leaves the published links, statuses, and history
intact. The frontend never requests status directly from GitHub.

Run the focused frontend tests with `node --test public-pr-status.test.cjs`.

Public assets retain the attribution notices in [assets](assets/README.md).
